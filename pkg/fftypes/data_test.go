// Copyright © 2021 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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

package fftypes

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDatatypeReference(t *testing.T) {

	var dr *DatatypeRef
	assert.Equal(t, nullString, dr.String())
	dr = &DatatypeRef{
		Name:    "customer",
		Version: "0.0.1",
	}
	assert.Equal(t, "customer/0.0.1", dr.String())

}

func TestValidateBadValidator(t *testing.T) {
	err := CheckValidatorType(context.Background(), "wrong")
	assert.Regexp(t, "FF10200", err)
}

func TestSealNoData(t *testing.T) {
	d := &Data{}
	err := d.Seal(context.Background())
	assert.Regexp(t, "FF10199", err)
}

func TestSealValueOnly(t *testing.T) {
	d := &Data{
		Value: []byte("{}"),
		Blob:  &BlobRef{},
	}
	err := d.Seal(context.Background())
	assert.NoError(t, err)
	assert.Equal(t, d.Hash.String(), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
}

func TestSealBlobOnly(t *testing.T) {
	blobHash, _ := ParseBytes32(context.Background(), "22440fcf4ee9ac8c1a83de36c3a9ef39f838d960971dc79b274718392f1735f9")
	d := &Data{
		Blob: &BlobRef{
			Hash: blobHash,
		},
	}
	err := d.Seal(context.Background())
	assert.NoError(t, err)
	assert.Equal(t, "22440fcf4ee9ac8c1a83de36c3a9ef39f838d960971dc79b274718392f1735f9", d.Hash.String())
}

func TestSealBlobAndHashOnly(t *testing.T) {
	blobHash, _ := ParseBytes32(context.Background(), "22440fcf4ee9ac8c1a83de36c3a9ef39f838d960971dc79b274718392f1735f9")
	d := &Data{
		Blob: &BlobRef{
			Hash: blobHash,
		},
		Value: []byte("{}"),
	}
	h := sha256.Sum256([]byte(`44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a22440fcf4ee9ac8c1a83de36c3a9ef39f838d960971dc79b274718392f1735f9`))
	err := d.Seal(context.Background())
	assert.NoError(t, err)
	assert.Equal(t, d.Hash[:], h[:])
}

func TestHashDataNull(t *testing.T) {

	jd := []byte(`{
		"id": "a64addf8-00e2-4210-9474-477e93b7f8dc",
		"validator": "none",
		"namespace": "default",
		"hash": "3e12f246f0d16ab3fe6d15d15161ca5de8a00991c98fa12cea1b9733ea9832da",
		"created": "2021-09-25T05:07:53.5847572Z",
		"datatype": {
			"name": "myblob"
		},
		"value": null,
		"blob": {
			"hash": "6014cbaf6bde9f9d755f347cb326db88859475e9d1a215d5dc4ccd8ae9caec7c"
		}
	}`)
	var d Data
	err := json.Unmarshal(jd, &d)
	assert.NoError(t, err)

	// Note that the processing of "null" means the value does not contribute to the hash
	expectedHash, err := ParseBytes32(context.Background(), "6014cbaf6bde9f9d755f347cb326db88859475e9d1a215d5dc4ccd8ae9caec7c")
	assert.NoError(t, err)
	hash, err := d.CalcHash(context.Background())
	assert.NoError(t, err)
	assert.Equal(t, expectedHash.String(), hash.String())

}
