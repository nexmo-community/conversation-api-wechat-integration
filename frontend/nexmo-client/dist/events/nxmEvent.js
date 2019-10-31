/*
 * Nexmo Client SDK
 *  NXMEvent Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const WildEmitter = require('wildemitter');
const NexmoClientError = require('../nexmoClientError').NexmoClientError;
const NexmoApiError = require('../nexmoClientError').NexmoApiError;

/**
 * Conversation NXMEvent Object.
 * The super class that holds the base events that apply to
 * common event objects.
 * @class NXMEvent
 */
class NXMEvent {
  constructor(conversation, params) {
    this.conversation = conversation;
    if (params) {
      for (const key in params) {
        switch (key) {
          case 'type':
            if (params.type.startsWith('custom:')) {
              this.type = params.type.replace('custom:', '');
            } else {
              this.type = params.type;
            }
            break;
          case 'cid':
            this.cid = params.cid;
            break;
          case 'from':
            this.from = params.from;
            break;
          case 'timestamp':
            this.timestamp = params.timestamp;
            break;
          case 'id':
            this.id = params.id;
            break;
          case 'state':
            this.state = params.state;
            break;
          case 'index':
            this.index = params.index;
            break;
          case 'streamIndex':
            this.streamIndex = params.streamIndex;
            break;
          case 'body':
            this.body = params.body;
            if (this.body.user && this.body.user.user_id) {
              this.body.user.id = this.body.user.user_id;
              delete this.body.user.user_id;
            }
            if (this.body.digit) {
              this.digit = this.body.digit;
              delete this.body.digit;
            }
            if (this.body.digits) {
              this.digit = this.body.digits;
              delete this.body.digits;
            }
            break;
        }
      }
    }
    WildEmitter.mixin(NXMEvent);
  }

  /**
   * Delete the event
   * @param {number} [event_id=this.event_id] if the event id param is not present, "this" event will be default
   * @returns {Promise}
   * @private
  */
  del(event_id = this.id) {
    return new Promise((resolve, reject) => {
      return this.conversation.application.session.sendNetworkRequest({
        type: 'DELETE',
        path: `conversations/${this.conversation.id}/events/${event_id}?from=${this.conversation.me.id}`,
        version: 'beta2'
      }).then((response) => {
        resolve();
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Mark as Delivered the event
   * @param {number} [event_id=this.event_id] if the event id is not provided, the this event will be used
   * @returns {Promise}
   * @private
   */
  delivered(event_id = this.id) {
    if (this.type !== 'text' && this.type !== 'image') {
      this.type = 'event';
    }
    return new Promise((resolve, reject) => {
      if (this.conversation.me.id === this.from) {
        reject(new NexmoClientError('error:delivered:own-message'));
      } else if (this.state && this.state.delivered_to && this.state.delivered_to[this.conversation.me.id]) {
        reject(new NexmoClientError('error:already-delivered'));
      } else {
        return this.conversation.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.conversation.id}/events`,
          data: {
            type: `${this.type}:delivered`,
            from: this.conversation.me.id,
            body: {
              event_id
            }
          }
        }).then((response) => {
          resolve();
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }

  /**
   * Mark as Seen the event
   * @param {number} [event_id=this.event_id] if the event id is not provided, the this event will be used
   * @returns {Promise}
   * @private
  */
  seen(event_id = this.id) {
    if (this.type !== 'text' && this.type !== 'image') {
      this.type = 'event';
    }
    return new Promise((resolve, reject) => {
      if (this.conversation.me.id === this.from) {
        reject(new NexmoClientError('error:seen:own-message'));
      } else if (this.state && this.state.seen_by && this.state.seen_by[this.conversation.me.id]) {
        reject(new NexmoClientError('error:already-seen'));
      } else {
        return this.conversation.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.conversation.id}/events`,
          data: {
            type: `${this.type}:seen`,
            from: this.conversation.me.id,
            body: {
              event_id
            }
          }
        }).then((response) => {
          resolve();
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }
}

module.exports = NXMEvent;
