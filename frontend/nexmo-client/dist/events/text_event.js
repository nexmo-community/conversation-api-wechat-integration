/*
 * Nexmo Client SDK
 *  Text NXMEvent Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const NXMEvent = require('./nxmEvent');

/**
 * A text event
 *
 * @class TextEvent
 * @extends NXMEvent
*/
class TextEvent extends NXMEvent {
  constructor(conversation, params) {
    super(conversation, params);
    this.type = 'text';
    this.conversation = conversation;
    this.state = {
      seen_by: {},
      delivered_to: {}
    };

    if (params && params.body && params.body.timestamp) {
      this.timestamp = params.body.timestamp;
    }

    Object.assign(this, params);
  }

  /**
   * Set the message status to 'seen'
   * @returns {Promise}
   */
  seen() {
    return super.seen();
  }

  /**
   * Set the message status to 'delivered'.
   * handled by the SDK
   * @returns {Promise}
   */
  delivered() {
    return super.delivered();
  }

  /**
   * Delete the event
   * @returns {Promise}
   */
  del() {
    return super.del();
  }
}

module.exports = TextEvent;
