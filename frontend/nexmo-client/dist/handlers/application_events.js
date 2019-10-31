/*
 * Nexmo Client SDK
 *  Application Events Handler
 *
 * Copyright (c) Nexmo Inc.
 */

const NXMEvent = require('../events/nxmEvent');
const NXMCall = require('../modules/nxmCall');
const Utils = require('../utils');
const getLogger = require('loglevel').getLogger;

/**
 * Handle Application Events
 *
 * @class ApplicationEventsHandler
 * @param {Application} application
 * @param {Conversation} conversation
 * @private
*/
class ApplicationEventsHandler {
  constructor(application) {
    this.log = getLogger(this.constructor.name);
    this.application = application;
    this._handleApplicationEventMap = {
      'member:joined': this._processMemberJoined,
      'member:invited': this._processMemberInvited
    };
  }

  /**
    * Handle and event.
    *
    * Update the event to map local generated events
    * in case we need a more specific event to pass in the application listener
    * or f/w the event as it comes
    * @param {object} event
    * @private
  */
  handleEvent(event) {
    const conversation = this.application.conversations.get(event.cid);
    const copied_event = Object.assign({}, event);

    if (this._handleApplicationEventMap.hasOwnProperty(event.type)) {
      return this._handleApplicationEventMap[event.type].call(this, conversation, new NXMEvent(conversation, copied_event)) || new NXMEvent(conversation, copied_event);
    }
    return new NXMEvent(conversation, copied_event);
  }

  /**
    * case: call to PSTN, after knocking event we receive joined
    * @private
  */
  _processMemberJoined(conversation, event) {
    if (event.body.channel && event.body.channel.knocking_id
            && this.application._call_draft_list.has(event.body.channel.knocking_id)) {
      const nxmCall = this.application._call_draft_list.get(event.body.channel.knocking_id);
      nxmCall._setFrom(conversation.me);
      nxmCall._setupConversationObject(conversation);
      this.application._call_draft_list.delete(event.body.channel.knocking_id);
      // remove the knocking id for the calls list
      // needs to be part of the call_draft_list for nxmCall.hangup to perform knocking:delete
      delete nxmCall.knocking_id;
      this.application.calls.set(conversation.id, nxmCall);
      nxmCall._handleStatusChange(event);
      this.application.emit('member:call', this.application.conversations.get(event.cid).members.get(event.from), nxmCall);
    }
    return event;
  }

  _processMemberInvited(conversation, event) {
    if (!conversation) {
      this.log.warn(`no conversation object for ${event.type}`);
      return event;
    }
    // no need to process the event if it's not media related invite, or the member is us
    if ((conversation.me && (conversation.me.user.id === event.body.invited_by))
      || (!event.body.user.media || !event.body.user.media.audio_settings
        || !event.body.user.media.audio_settings.enabled)) {
      return event;
    }

    const caller = Utils.getMemberNumberFromEventOrNull(event.body.channel) ||
      Utils.getMemberFromNameOrNull(conversation, event.body.invited_by) || 'unknown';

    // (IP - IP call)
    if (conversation.display_name && conversation.display_name.startsWith('CALL_')) {
      const nxmCall = new NXMCall(this.application, conversation, caller);
      this.application.calls.set(conversation.id, nxmCall);
      this.application.emit('member:call', this.application.conversations.get(event.cid).members.get(event.from), nxmCall);
      // VAPI invites (PHONE - IP)
    } else if (!event.body.invited_by) {
      const nxmCall = new NXMCall(this.application, conversation, caller);
      this.application.calls.set(conversation.id, nxmCall);
      nxmCall._handleStatusChange(event);
      this.application.emit('member:call', this.application.conversations.get(event.cid).members.get(event.from), nxmCall);
    }
    return event;
  }
}

module.exports = ApplicationEventsHandler;
