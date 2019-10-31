/*
 * Nexmo Client SDK
 *  Conversation Events Handler
 *
 * Copyright (c) Nexmo Inc.
 */

const getLogger = require('loglevel').getLogger;
const NXMEvent = require('../events/nxmEvent');
const TextEvent = require('../events/text_event');
const ImageEvent = require('../events/image_event');

/**
 * Handle Conversation Events
 *
 * @class ConversationEventsHandler
 * @param {Application} application
 * @param {Conversation} conversation
 * @private
*/
class ConversationEventHandler {
  constructor(application, conversation) {
    this.log = getLogger(this.constructor.name);
    this.application = application;
    this.conversation = conversation;
    this.constructed_event = null;
    this._handleEventMap = {
      'event:delete': this._processDelete,

      'image': this._processImage,
      'image:delivered': this._processDelivered,
      'image:seen': this._processSeen,

      'member:invited': this._processMember,
      'member:joined': this._processMember,
      'member:left': this._processMember,
      'audio:ringing:start': this._processMember,

      'leg:status:update': this._processLegStatus,

      'member:media': this._processMedia,

      'text': this._processText,
      'text:delivered': this._processDelivered,
      'text:seen': this._processSeen,

      'audio:mute:on': this._processMuteForMedia,
      'audio:mute:off': this._processMuteForMedia,
      'video:mute:on': this._processMuteForMedia,
      'video:mute:off': this._processMuteForMedia
    };
  }

  /**
    * Handle and event.
    *
    * Identify the type of the event,
    * create the corresponding Class instance
    * emit to the corresponding Objects
    * @param {object} event
    * @private
  */
  handleEvent(event) {
    if (this._handleEventMap.hasOwnProperty(event.type)) {
      return this._handleEventMap[event.type].call(this, event) || new NXMEvent(this.conversation, event);
    }
    return new NXMEvent(this.conversation, event);
  }

  /**
    * Mark the requested event as delivered
    * use that event as constructed to update the local events' map
	  * @param {object} event
    * @returns the NXMEvent that is marked as delivered
    * @private
  */
  _processDelivered(event) {
    let event_to_mark = this.conversation.events.get(event.body.event_id);
    if (event_to_mark) {
      event_to_mark.state = event_to_mark.state || {};
      event_to_mark.state.delivered_to = event_to_mark.state.delivered_to || {};
      event_to_mark.state.delivered_to[event.from] = event.timestamp;
      return event_to_mark;
    } else {
      this.log.warn('NXMEvent not found');
      return null;
    }
  }

  /**
    * Delete the requested event
    * empty the payload of the event (text or image)
    * use that event as constructed to update the local events' map
    * @param {object} event
    * @returns the deleted events
    * @private
  */
  _processDelete(event) {
    let event_to_delete = this.conversation.events.get(event.body.event_id);
    if (event_to_delete) {
      if (event_to_delete.body.text) event_to_delete.body.text = '';
      if (event_to_delete.body.representations) event_to_delete.body.representations = '';
      event_to_delete.body.timestamp = {
        deleted: event.timestamp
      };
      return event_to_delete;
    } else {
      this.log.warn('NXMEvent not found');
      return null;
    }
  }

  /**
    * Return an ImageEvent with the corresponding image data
    * @param {object} event
    * @returns {ImageEvent}
  */
  _processImage(event) {
    const imageEvent = new ImageEvent(this.conversation, event);
        // Automatically send a delivery
        // avoid sending delivered to our own events
    if (this.conversation.me.id !== imageEvent.from) {
      imageEvent.delivered().catch((error) => {
        this.log.debug(error);
      });
    }
    return imageEvent;
  }

  /**
    * Handle events for member state changes (joined, invited, left)
    * in conversation level.
    * Other members are going through here too.
    * For .me member initial event (join, invite) use the application listener
	  * @param {object} event
    * @returns {NXMEvent}
    * @private
  */
  _processMember(event) {
    // needs to first process the call state and then alter the member
    if (this.application.calls.has(this.conversation.id)) {
      let call = this.application.calls.get(this.conversation.id);
      call._handleStatusChange(event);
    }
    this.conversation.members.get(event.from)._handleEvent(event);
    return new NXMEvent(this.conversation, event);
  }

  /**
   * Handle events for leg status updates in conversation level.
   * Other member's legs are going through here too.
   * @param {object} event
   * @returns {NXMEvent}
   * @private
  */
  _processLegStatus(event) {
    this.conversation.members.get(event.from)._handleEvent(event);
    return new NXMEvent(this.conversation, event);
  }

  /**
    * Handle member:media events
    * use a call object if and the member object
	  * @param {object} event
    * @private
  */
  _processMedia(event) {
    this.conversation.members.get(event.from)._handleEvent(event);
    return null;
  }

  /**
    * Handle *:mute:* events
	  * @param {object} event
    * @private
  */
  _processMuteForMedia(event) {
    if (this.conversation.media.rtcObjects[event.body.rtc_id]) {
      event.streamIndex = this.conversation.media.rtcObjects[event.body.rtc_id].streamIndex;
    } else if (this.conversation.remoteMembers) {
      const remote = this.conversation.remoteMembers.find((remoteMember) =>
        remoteMember.remote_leg_id === event.body.rtc_id);

      if (remote) {
        event.streamIndex = remote.streamIndex;
      }
    }
    return null;
  }

  /**
    * Mark the requested event as seen
    * use that event as constructed to update the local Events' map
	  * @param {object} event
    * @private
  */
  _processSeen(event) {
    let event_to_mark = this.conversation.events.get(event.body.event_id);
    if (event_to_mark) {
      event_to_mark.state = event_to_mark.state || {};
      event_to_mark.state.seen_by = event_to_mark.state.seen_by || {};
      event_to_mark.state.seen_by[event.from] = event.timestamp;
      return event_to_mark;
    } else {
      this.log.warn('NXMEvent not found');
      return null;
    }
  }

  /**
    * Create the TextEvent object and trigger .delivered()
	  * @param {object} event
    * @private
  */
  _processText(event) {
    const textEvent = new TextEvent(this.conversation, event);
    // Automatically send a delivery
    // avoid sending delivered to our own events
    if (this.conversation.me.id !== textEvent.from) {
      textEvent.delivered().catch((error) => {
        this.log.debug(error);
      });
    }
    return textEvent;
  }
}

module.exports = ConversationEventHandler;
