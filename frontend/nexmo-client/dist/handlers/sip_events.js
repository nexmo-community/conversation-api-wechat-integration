/*
 * Nexmo Client SDK
 *  SIP Events Handler
 *
 * Copyright (c) Nexmo Inc.
 */

const getLogger = require('loglevel').getLogger;

/**
 * Handle sip Events
 *
 * @class SipEventHandler
 * @private
  */
class SipEventHandler {
  constructor(application) {
    this.log = getLogger(this.constructor.name);
    this.application = application;
  }

	/**
	 * Entry point for sip events
	 * The event belongs to a call Object
	 * @private
	*/
  _handleSipCallEvent(event) {
    if (!this.application.calls.has(event.cid)) {
      this.log.warn('There is no call object for this Conversation id.');
      return;
    }
    const event_call = this.application.calls.get(event.cid);
    const _handleSipCallEventMap = {
      'sip:hangup': () => {
        event_call._handleStatusChange(event);
      },
      'sip:ringing': () => {
        event_call._handleStatusChange(event);
      }
    };
    if (_handleSipCallEventMap.hasOwnProperty(event.type)) {
      return _handleSipCallEventMap[event.type].call(this);
    }
  }
}

module.exports = SipEventHandler;
