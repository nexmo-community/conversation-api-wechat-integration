/*
 * Nexmo Client SDK
 *  Errors Emitter
 *
 * Copyright (c) Nexmo Inc.
*/

const getLogger = require('loglevel').getLogger;
const NexmoClientError = require('../nexmoClientError').NexmoClientError;

/**
 * Class that can emit errors via any emitter passed to it.
 * @class ErrorsEmitter
 * @param {Emitter} emitter - Any event emitter that implements "emit" and "releaseGroup". Basically object that is mixed with Wildemitter.
 * @property {string} LISTENER_GROUP='NXM-errors' - the group this emitter will register
 * @emits Emitter#NXM-errors
 * @private
*/

/**
 * Application listening for joins.
 *
 * @event Application#NXM-errors
 *
 * @property {NexmoClientError} error
 *
 * @example <caption>listen for errors</caption>
 * application.on('*', 'NXM-errors', (error) => {
 *    console.log('Error thrown with type ' + error.type);
 *  });
 * @example <caption>Update the token on expired-token error</caption>
 * application.on('system:error:expired-token', 'NXM-errors', (error) => {
 * 	console.log('token expired');
 * 	application.updateToken(<token>);
 * });
*/
class ErrorsEmitter {
  constructor(emitter) {
    this.log = getLogger(this.constructor.name);

    if (!emitter) {
      throw new NexmoClientError('no emitter object passed for the Error Emitter');
    }
    this.emitter = emitter;
    this.LISTENER_GROUP = 'NXM-errors';
  }
  /**
   * Detect if the param.type includes error and emit that payload in the LISTENER_GROUP
   * @param param - the payload to forward in the LISTENER_GROUP
   * @param param.type - the type of the event to check if it's an error
  */
  emitResponseIfError(param) {
    if (this._isTypeError(param.type)) {
      return this.emitter.emit(param.type, this.LISTENER_GROUP, param);
    }
    return;
  }

  /**
   * Release Group on the registered emitter (using the namespace LISTENER_GROUP that is set)
  */
  cleanup() {
    return this.emitter.releaseGroup(this.LISTENER_GROUP);
  }

  /**
   * Returns true if the param includes 'error'
   * @param {string} type - the error type to check
  */
  _isTypeError(param) {
    return param.indexOf('error') !== -1;
  }
}

module.exports = ErrorsEmitter;
