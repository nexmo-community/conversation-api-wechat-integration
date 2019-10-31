/*
 * Nexmo Client SDK
 *  RTC Events Handler
 *
 * Copyright (c) Nexmo Inc.
 */

const getLogger = require('loglevel').getLogger;

/**
 * Handle rtc Events
 *
 * @class RtcEventHandler
 * @private
*/
class RtcEventHandler {
  constructor(application) {
    this.log = getLogger(this.constructor.name);
    this.application = application;
  }

	/**
	 * Entry point for rtc events
	 * @private
	*/
  _handleRtcEvent(event) {
    const _handleRtcEventMap = {
			/**
			 * on transfer event
			 * update the conversation object in the NXMCall,
			 * update the media object in the new conversation
			 * set `transferred_to` <Conversation> on the member that is transferred
			 */
      'rtc:transfer': () => {
        const old_conversation = this.application.conversations.get(event.body.transferred_from);
        const new_conversation = this.application.conversations.get(event.cid);
        const nxmCall = this.application.calls.get(event.body.transferred_from);
        if (!nxmCall) {
          this.log.warn('NXMCall transfer for unknown nxmCall');
          return;
        }
				// mark the transferred member in the old conversation
        nxmCall.conversation.members.get(event.body.was_member).transferred_to = new_conversation;
        nxmCall._setupConversationObject(new_conversation);
        nxmCall.transferred = true;
        this.application.calls.set(event.cid, nxmCall);
        this.application.calls.delete(event.body.transferred_from);
				// in case we joined in the middle of a transfer and we don't have the
				// previous conversation in our list yet
        if (old_conversation) {
          new_conversation.members.get(event.from).transferred_from = old_conversation;
          new_conversation.media._attachEndingEventHandlers();
					// transfer remote member (video cases)
          old_conversation.remoteMembers.map((member) => {
            if (member.remote_member_id === event.from) {
              new_conversation.remoteMembers.push(member);
              old_conversation.remoteMembers.splice(
                  old_conversation.remoteMembers.indexOf(member), 1);
            }
          });
        }
      },
      'rtc:answer': () => {
        if (this.application.calls.has(event.cid)) {
          this.application.calls.get(event.cid).id = event.body.rtc_id;
        }
      }
    };
    if (_handleRtcEventMap.hasOwnProperty(event.type)) {
      return _handleRtcEventMap[event.type].call(this);
    }
  }
}

module.exports = RtcEventHandler;
