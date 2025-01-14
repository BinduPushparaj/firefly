// Code generated by mockery v1.0.0. DO NOT EDIT.

package blockchainmocks

import (
	blockchain "github.com/hyperledger/firefly/pkg/blockchain"
	fftypes "github.com/hyperledger/firefly/pkg/fftypes"

	mock "github.com/stretchr/testify/mock"
)

// Callbacks is an autogenerated mock type for the Callbacks type
type Callbacks struct {
	mock.Mock
}

// BatchPinComplete provides a mock function with given fields: batch, signingIdentity, protocolTxID, additionalInfo
func (_m *Callbacks) BatchPinComplete(batch *blockchain.BatchPin, signingIdentity string, protocolTxID string, additionalInfo fftypes.JSONObject) error {
	ret := _m.Called(batch, signingIdentity, protocolTxID, additionalInfo)

	var r0 error
	if rf, ok := ret.Get(0).(func(*blockchain.BatchPin, string, string, fftypes.JSONObject) error); ok {
		r0 = rf(batch, signingIdentity, protocolTxID, additionalInfo)
	} else {
		r0 = ret.Error(0)
	}

	return r0
}

// BlockchainOpUpdate provides a mock function with given fields: operationID, txState, errorMessage, opOutput
func (_m *Callbacks) BlockchainOpUpdate(operationID *fftypes.UUID, txState fftypes.OpStatus, errorMessage string, opOutput fftypes.JSONObject) error {
	ret := _m.Called(operationID, txState, errorMessage, opOutput)

	var r0 error
	if rf, ok := ret.Get(0).(func(*fftypes.UUID, fftypes.OpStatus, string, fftypes.JSONObject) error); ok {
		r0 = rf(operationID, txState, errorMessage, opOutput)
	} else {
		r0 = ret.Error(0)
	}

	return r0
}
