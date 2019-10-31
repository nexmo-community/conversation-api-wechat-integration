/*
 * Nexmo Client SDK
 *  Member Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const WildEmitter = require('wildemitter');
const NXMEvent = require('./events/nxmEvent');
const Utils = require('./utils');
const NexmoApiError = require('./nexmoClientError').NexmoApiError;

/**
 * An individual user (i.e. conversation member).
 * @class Member
 * @param {Conversation} conversation
 * @param {object} params
*/
class Member {
  constructor(conversation, params) {
    this.conversation = conversation;
    this.callStatus = null;
    this._normalise(params);
    WildEmitter.mixin(Member);
  }
	/**
	 * Update object instance and align attribute names
	 *
	 * Handle params input to keep consistent the member object
	 * @param {object} params member attributes
	 * @private
	*/
  _normalise(params) {
    if (params) {
      this.user = this.user || {};
      this.channel = params.channel || {
        type: 'app'
      };

      for (let key in params) {
        switch (key) {
          case 'member_id':
            this.id = params.member_id;
            break;
          case 'timestamp':
            this.timestamp = params.timestamp;
            break;
          case 'state':
            this.state = params.state;
            break;
          case 'from':
            this.id = params.from; // special case for member events
            break;
          case 'user_id':
            this.user.id = params.user_id;
            break;
          case 'name':
            this.user.name = params.name;
            break;
          case 'user':
            this.user = {
              name: params.user.name,
              id: params.user.user_id || params.user.id
            };
            this.display_name = this.display_name || params.user.display_name;
            break;
          case 'invited_by':
            this.invited_by = params.invited_by;
            break;
          case 'display_name':
            this.display_name = this.display_name || params.display_name;
            break;
          case 'conversation':
            break;
          default:
            if (!params.type) {
              this[key] = params[key];
            }
        }
      }

      // join conversation returns our member with only id,
      // compare it for now and use the username we have in the application object
      if (this.conversation.application.me && params.user_id === this.conversation.application.me.id) {
        this.user.name = this.conversation.application.me.name;
      }
      // make sure we don't keep a member.user_id, name in any flow
      delete this.user_id;
      delete this.name;
      delete this.user.user_id;
    }
  }

	/**
	 * Play the given stream only to this member within the conversation
	 *
	 * @param {string} [params]
	 *
	 * @returns {Promise<NXMEvent>}
	 * @private
	*/
  playStream(params) {
    return new Promise((resolve, reject) => {
      return this.conversation.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.id}/events`,
        data: {
          type: 'audio:play',
          to: this.id,
          body: params
        }
      }).then((response) => {
        resolve(new NXMEvent(this.conversation, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

	/**
	 * Speak the given text only to this member within the conversation
	 *
	 * @param {string} [params]
	 *
	 * @returns {Promise<NXMEvent>}
	 * @private
	*/
  sayText(params) {
    return new Promise((resolve, reject) => {
      return this.conversation.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.id}/events`,
        data: {
          type: 'audio:say',
          cid: this.id,
          from: this.conversation.me.id,
          to: this.id,
          body: {
            text: params.text,
            voice_name: params.voice_name || 'Amy',
            level: params.level || 1,
            queue: params.queue || true,
            loop: params.loop || 1,
            ssml: params.ssml || false
          }
        }
      }).then((response) => {
        resolve(new NXMEvent(this.conversation, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

	/**
	 * Kick this member from the conversation
	 *
   * @param {object} [reason] the reason for kicking out a member
   * @param {string} [reason.reason_code] the code of the reason
   * @param {string} [reason.reason_text] the description of the reason
	 * @returns {Promise}
	*/
  kick(reason) {
    return new Promise((resolve, reject) => {
      let path = `conversations/${this.conversation.id}/members/${this.id}`;
      if (reason) {
        let params = new URLSearchParams();
        Object.keys(reason).forEach((key) => {
          params.append(key, reason[key]);
        });
        path += `?${params.toString()}`;
      }

      return this.conversation.application.session.sendNetworkRequest({
        type: 'DELETE',
        path
      }).then((response) => {
        resolve(response);
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Mute a stream
   *
   * @param {boolean} [mute] true for mute, false for unmute
   * @param {boolean} [audio=true] true for audio stream
   * @param {boolean} [video=false] true for video stream
   * @param {number} [streamIndex] stream index of the stream
   * @example <caption>Mute audio stream</caption>
   * media.mute(true, true, false)
   * @example <caption>Mute audio and video streams</caption>
   * media.mute(true, true, true)
   * @example <caption>Mute only video</caption>
   * media.mute(true, false, true)
  */
  mute(mute) {
    return this.conversation.media.mute(mute);
  }

	/**
	 * Earmuff this member
	 *
	 * @param {boolean} [params]
	 *
	 * @returns {Promise}
	 *
	*/
  earmuff(earmuff) {
    return this.conversation.media.earmuff(earmuff);
  }

	/**
	 * Handle member object events
	 *
	 * Handle events that are modifying this member instance
	 * @param {NXMEvent} event invited, joined, left, media events
	 * @private
	*/
  _handleEvent(event) {
    switch (event.type) {
      case 'member:invited':
        this._normalise(event.body); // take care of misaligned objects.
        this.state = 'INVITED';
        this.timestamp.invited = event.body.timestamp.invited;

        if (!event.body.invited_by && event.body.user.media && event.body.user.media.audio_settings
          && event.body.user.media.audio_settings.enabled) {
          this._setCallStatusAndEmit('started');
        }
        break;
      case 'member:joined':
        this._normalise(event.body); // take care of misaligned objects.
        this.state = 'JOINED';
        this.timestamp.joined = event.body.timestamp.joined;

        if (event.body.channel && event.body.channel.knocking_id) {
          this._setCallStatusAndEmit('started');
        }
        break;
      case 'member:left':
        this._normalise(event.body); // take care of misaligned objects.
        this.state = 'LEFT';
        this.timestamp.left = event.body.timestamp.left;

        if (event.body.reason && event.body.reason.text) {
          this._setCallStatusAndEmit(event.body.reason.text);
        }
        break;
      case 'member:media':
        this.media = event.body.media;
        break;
      case 'leg:status:update':
        this.channel.legs = Utils.updateMemberLegs(this.channel.legs, event);
        this._setCallStatusAndEmit(event.body.status);
        break;
      case 'audio:ringing:start':
        if (!this.callStatus || this.callStatus === 'started') {
          this._setCallStatusAndEmit('ringing');
        }
        break;
      default:
        break;
    }
  }

  /**
	 * Set the member.callStatus and emit a member:call:status event
	 *
	 * @param {Member.callStatus} this.callStatus the call status to set
	 * @private
	*/
  _setCallStatusAndEmit(callStatus) {
    if (this.callStatus !== String(callStatus)) {
      this.callStatus = callStatus;
      this.conversation.emit('member:call:status', this);
    }
  }
}

module.exports = Member;
