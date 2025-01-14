// Copyright © 2021 Kaleido, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { clearTimeout, setTimeout } from 'timers';
import { promisify } from 'util';
import { v4 as uuidV4 } from 'uuid';
import * as database from '../clients/database';
import { IBatchRecord, IDBBatch } from './interfaces';
import * as utils from './utils';

const delay = promisify(setTimeout);

const log = utils.getLogger('lib/batch-processor.ts');

export interface IBatchProcessorConfig {
  addTimeoutMS: number;  
  batchTimeoutArrivallMS: number;
  batchTimeoutOverallMS: number;
  batchMaxRecords: number;
  retryInitialDelayMS: number;
  retryMaxDelayMS: number;
  retryMultiplier: number;
}

interface BatchAssemblyTask {
  timestamp: number;
  record: IBatchRecord;
  resolve: (batchID: string) => void;
  reject: (err: Error) => void;
}

/**
 * A singleton of these should be created for each batch type + author combination.
 * 
 * A persistent batch implementation, which:
 * - Is safe for calling concurrently on many async contexts
 * - Guarantees to persists batch updates to the database before returning from add
 * - Blocks the caller from getting more than one batch ahead
 * - Protects against the caller of add (such as a REST API) giving up on a timeout before their record is accepted
 * - Recovers in-flight batches on initialization
 * - Pipelines the processing of one batch, with the building of the next
 * - Retries accepted batches indefinitely
 */
export class BatchProcessor {

  private assemblyList: BatchAssemblyTask[];
  private assembling: boolean;
  private assemblyBatch?: IDBBatch;
  private dispatchTimeout?: NodeJS.Timeout;
  private batchInFlight?: Promise<void>;
  public config: IBatchProcessorConfig;

  constructor(
    private author: string,
    private type: string,
    private processBatchCallback: (batch: IDBBatch) => Promise<void>,
    private processorCompleteCallback: (author: string, type: string) => void,
    config?: Partial<IBatchProcessorConfig>,
  ) {
    this.assemblyList = [];
    this.assembling = false;
    this.config = {
      addTimeoutMS: utils.constants.BATCH_ADD_TIMEOUT_MILLIS,
      batchTimeoutArrivallMS: utils.constants.BATCH_TIMEOUT_ARRIVAL_MILLIS,
      batchTimeoutOverallMS: utils.constants.BATCH_TIMEOUT_OVERALL_MILLIS,
      batchMaxRecords: utils.constants.BATCH_MAX_RECORDS,
      retryInitialDelayMS: utils.constants.BATCH_RETRY_INITIAL_DELAY_MILLIS,
      retryMaxDelayMS: utils.constants.BATCH_RETRY_MAX_DELAY_MILLIS,
      retryMultiplier: utils.constants.BATCH_RETRY_MULTIPLIER,
      ...config,
    }
  }

  public async init(incompleteBatches: IDBBatch[]) {
    // Treat the stored batches just as we would do filled batches.
    // This logic blocks startup until we queued dispatch of all persisted batches
    // (there should be a maximum of two, for the author+type combination)
    while (incompleteBatches.length) {
      this.assemblyBatch = incompleteBatches.shift();
      await this.dispatchBatch();
    }
  }

  /**
   * Blocks until the requested record has been assigned to a batch, and its inclusion
   * in that batch has been persisted to our local database.
   * @param record the record to add to a batch
   * @returns {string} the batchID the add was persisted into
   */
  public async add(record: IBatchRecord): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Add our record to the assember queue, to resove the parent promise
      this.assemblyList.push({ timestamp: Date.now(), record, resolve, reject });
      // Give the assembler a kick, as it might not be already running
      this.assembler();
    });
  }

  protected newBatch(): IDBBatch {
    const timestamp = Date.now();
    return {
      type: this.type,
      author: this.author,
      batchID: uuidV4(),
      created: timestamp,
      completed: null,
      records: [],
    };
  }

  // Safety check to make sure we haven't got work queued into the system
  // from a long time ago, that potentially a REST client has forgotten about.
  // These are rejected at the point they are detected, before we do any active
  // processing on them.
  private rejectAnyStale() {
    const now = Date.now();
    const newAssemblyList = [];
    for (const a of this.assemblyList) {
      const inFlightTime = now - a.timestamp;
      if (inFlightTime > this.config.addTimeoutMS) {
        a.reject(new Error(`Timed out add of record after ${inFlightTime}ms`))
      } else {
        newAssemblyList.push(a);
      }
    }
    this.assemblyList = newAssemblyList;
    return this.assemblyList;
  }

  private async assembler() {

    // Use each add as an opportunity to check for stales
    this.rejectAnyStale();

    // If we've already got an assembler running, nothing more to do
    if (this.assembling) return;

    // We are the assembler - stop an duplicate one running (cleared before return)
    this.assembling = true;
    let chosen: BatchAssemblyTask[] = [];
    while (this.rejectAnyStale().length) {
      try {

        // Create a new assembly batch if we don't currently have one
        if (!this.assemblyBatch) this.assemblyBatch = this.newBatch();
        const batch = this.assemblyBatch;

        // Grab as much capacity as we can out of the assemblyList
        let capacity = this.config.batchMaxRecords - batch.records.length;
        chosen = this.assemblyList.slice(0, capacity);
        this.assemblyList = this.assemblyList.slice(capacity);

        // Add these entries to the in-memory batch object
        for (let a of chosen) {
          batch.records.push(a.record);
        }

        // Persist the batch object to our local database
        log.trace(`${this.type}/${this.author}: added ${chosen.length} records to batch ${batch.batchID}`);
        await database.upsertBatch(batch);

        // Check if the batch is full
        if (batch.records.length >= this.config.batchMaxRecords) {
          // Only one batch can be dispatched, so this is a blocking call if we manage
          // to run more than one batch ahead of the assembler.
          await this.dispatchBatch();
        } else {
          // Set/reset the timer to dispatch this batch
          const now = Date.now();
          if (this.dispatchTimeout) clearTimeout(this.dispatchTimeout);
          this.dispatchTimeout = setTimeout(() => this.dispatchBatch(),
            Math.min(
              // The next record must arrive within the batchTimeoutArrivallMS
              this.config.batchTimeoutArrivallMS,
              // The first record in the batch cannot be delayed by more than the batchTimeoutOverallMS
              (batch.created + this.config.batchTimeoutOverallMS) - now,
            )
          );
        }

        // ****
        // Note that this point this.assemblyBatch might be undefined, if we just dispatched it.
        // It is also NOT SAFE to do do any async processing here, because the processBatch
        // logic relies us to exit if this.assemblyBatch to be undefined when the batch completes.
        // So we need to go round to `newBatch` again without any async logic.
        // ***

        // We have accepted all the chosen records into a persisted batch, ready for dispatch.
        // This unblocks any callers waiting to know what batch they are in.
        for (let a of chosen) a.resolve(batch.batchID);
      }
      catch(err) {
        log.error(`${this.type}/${this.author}: Batch assembler failed`, err);
        for (let a of chosen) a.reject(err);
      }
    }
    this.assembling = false;
  }

  protected async dispatchBatch() {
    if (this.batchInFlight) await this.batchInFlight;
    if (this.dispatchTimeout) clearTimeout(this.dispatchTimeout);
    const batch = this.assemblyBatch;
    delete this.assemblyBatch;
    delete this.dispatchTimeout;
    if (!batch) return; // Covers the posibility of a timer and the assember loop both firing
    const batchTime = Date.now() - batch.created;
    log.info(`${this.type}/${this.author}: closed batch ${batch.batchID} after ${batchTime}ms with ${batch.records.length} records`);
    // Capture the promise for competion of this batch, to block any further dispatchBatch calls
    this.batchInFlight = this.processBatch(batch);
  }

  protected async processBatch(batch: IDBBatch) {
    // We have accepted the batch at this point, and the REST calls to submit it to us have all completed.
    // So we cannot fail to process it, and we must retry the processing indefinitely
    let attempt = 0;
    let complete = false;
    while (!complete) {
      try {
        attempt++;

        // Set the completed time in memory - forms part of uniqueness in the pinning process.
        batch.completed = Date.now();
        await this.processBatchCallback(batch);

        // Update the batch as complete - writes the now final completed timestamp, along with any updates made in processBatchCallback
        await database.upsertBatch(batch);
        
        // Ok, we're done here.
        complete = true;
      }
      catch(err) {
        let retryDelay = this.config.retryInitialDelayMS;
        for (let i = 1; i < attempt; i++) retryDelay *= this.config.retryMultiplier;
        retryDelay = Math.min(retryDelay, this.config.retryMaxDelayMS);
        log.error(`${this.type}/${this.author}: batch ${batch.batchID} attempt ${attempt} failed (next-retry: ${retryDelay}ms): ${err.stack}`);
        await delay(retryDelay);
      }  
    }

    // If there's nothing queued up, we call the completion handler that was passed in,
    // to let them unregister this batch processor.
    // This is because there are potentially infinite 'author' addresses that could be used,
    // so leaving ourselves around indefinitely just because someone submitted on transaction
    // would be a memory leak.
    if (!this.assemblyBatch) {
      this.processorCompleteCallback(this.author, this.type);
    }

  }

}