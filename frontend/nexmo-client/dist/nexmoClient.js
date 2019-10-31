(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  Application Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const WildEmitter = require('wildemitter');
const getLogger = require('loglevel').getLogger;
const User = require('./user');
const Conversation = require('./conversation');
const NXMCall = require('./modules/nxmCall');
const SipEventHandler = require('./handlers/sip_events');
const RtcEventHandler = require('./handlers/rtc_events');
const ApplicationEventsHandler = require('./handlers/application_events');
const Utils = require('./utils');
const PageConfig = require('./pages/page_config');
const ConversationsPage = require('./pages/conversations_page');
const NexmoClientError = require('./nexmoClientError').NexmoClientError;
const NexmoApiError = require('./nexmoClientError').NexmoApiError;

let sipEventHandler = null;
let rtcEventHandler = null;
let applicationEventsHandler = null;

/**
 * Core application class for the SDK.
 * Application is the parent object holding the list of conversations, the session object.
 * Provides methods to create conversations and retrieve a list of the user's conversations, while it holds the listeners for
 * user's invitations
 * @class Application
 * @param {NexmoClient} SDK session Object
 * @param {object} params
 * @example <caption>Accessing the list of conversations</caption>
 *   rtc.login(token).then((application) => {
      console.log(application.conversations);
      console.log(application.me.name, application.me.id);
 });
 * @emits Application#member:invited
 * @emits Application#member:joined
 * @emits Application#NXM-errors
*/
class Application {
  constructor(session, params) {
    this.log = getLogger(this.constructor.name);
    this.session = session;
    this.conversations = new Map();
    this.synced_conversations_count = 0;
    this.start_sync_time = 0;
    this.stop_sync_time = 0;
    // conversation_id, nxmCall
    this.calls = new Map();
    // knocking_id, nxmCall
    this._call_draft_list = new Map();
    this.pageConfig = new PageConfig((session.config || {}).conversations_page_config);
    this.conversations_page_last = null;

    sipEventHandler = new SipEventHandler(this);
    rtcEventHandler = new RtcEventHandler(this);
    applicationEventsHandler = new ApplicationEventsHandler(this);

    this.me = null;
    Object.assign(this, params);
    WildEmitter.mixin(Application);
  }

	/**
	 * Update Conversation instance or create a new one.
	 *
	 * Pre-created conversation exist from getConversations
	 * like initialised templates. When we explicitly ask to
	 * getConversation(), we receive members and other details
	 *
	 * @param {object} payload Conversation payload
	 * @private
	*/
  updateOrCreateConversation(payload) {
    const conversation = this.conversations.get(payload.id);
    if (conversation) {
      conversation._updateObjectInstance(payload);
      this.conversations.set(payload.id, conversation);
    } else {
      this.conversations.set(payload.id, new Conversation(this, payload));
    }
    return this.conversations.get(payload.id);
  }

	/**
	 * Application listening for invites.
	 *
	 * @event Application#member:invited
	 *
	 * @property {Member} member - The invited member
	 * @property {NXMEvent} event - The invitation event
	 *
	 * @example <caption>listen for your invites</caption>
	 * application.on("member:invited",(member, event) => {
	 *      console.log("Invited to the conversation: " + event.conversation.display_name || event.conversation.name);
	 *
	 * // identify the sender.
	 * console.log("Invited by: " + member.invited_by);
	 *
	 * //accept an invitation.
	 *  application.conversations.get(event.conversation.id).join();
	 *
	 * //decline the invitation.
	    application.conversations.get(event.conversation.id).leave();
	*/

	/**
	 * Application listening for joins.
	 *
	 * @event Application#member:joined
	 *
	 * @property {Member} member - the member that joined the conversation
	 * @property {NXMEvent} event - the join event
	 *
	 * @example <caption>listen join events in Application level</caption>
	 *  application.on("member:joined",(member, event) => {
	 *              console.log("JOINED", "Joined conversation: " + event.conversation.display_name || event.conversation.name);
	 *              });
	 *      });
	*/

	/**
	 * Entry point for events in Application level
	 * @private
	*/
  _handleEvent(event) {
    const isEventFromMe = event.body && event.body.user && event.body.user.user_id === this.me.id;
    if (event.type.startsWith('sip')) {
      sipEventHandler._handleSipCallEvent(event);
      return;
    }
    if (this.conversations.has(event.cid)) {
      if (event.type.startsWith('rtc')) {
        rtcEventHandler._handleRtcEvent(event);
      }

      this.conversations.get(event.cid)._handleEvent(event);
      if ((event.type === 'member:joined' || event.type === 'member:invited')
        && isEventFromMe) {
        this._handleApplicationEvent(event);
      }
    } else {
      // get the conversation you don't know about (case: joined by another user)
      this.getConversation(event.cid)
          .then((conversation) => {
            this.conversations.set(event.cid, conversation);
            conversation._handleEvent(event);
            this._handleApplicationEvent(event);
            if (event.type.startsWith('rtc')) {
              rtcEventHandler._handleRtcEvent(event);
            }
          }).catch((error) => {
            this.log.error(error);
          });
    }
  }

	/**
	 * update user's token
	 * @param {string} token - the new token
	 * @returns {Promise}
	*/
  updateToken(token) {
    return new Promise((resolve, reject) => {
      this.session.sendRequest({
        type: 'session:update-token',
        body: {
          token: token
        }
      }, (response) => {
        if (response.type === 'session:update-token:success') {
          if (this.me) {
            this.session._updateTokenInStorage(token, this.me.name);
          }
          resolve();
        } else {
          reject(new NexmoApiError(response));
        }
      });
    });
  }

	/**
	 * Update the event to map local generated events
	 * in case we need a more specific event to pass in the application listener
	 * or f/w the event as it comes
	 * @private
	*/
  _handleApplicationEvent(event) {
    const processed_event = applicationEventsHandler.handleEvent(event);
    this.emit(processed_event.type, this.conversations.get(event.cid).members.get(processed_event.from), processed_event);
  }

	/**
	 * Creates a call to specified user/s.
	 * @classdesc creates a call between the defined users
	 * @param {string[]} usernames - the user names for those we want to call
	 * @returns {NXMCall} a NXMCall object with all the call properties
	*/
  inAppCall(usernames) {
    return new Promise((resolve, reject) => {
      if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
        return reject(new NexmoClientError('error:application:call:params'));
      }
      const nxmCall = new NXMCall(this);
      return nxmCall.createCall(usernames)
          .then(() => {
            nxmCall.direction = nxmCall.CALL_DIRECTION.OUTBOUND;
            return resolve(nxmCall);
          }).catch((err) => {
            reject(err);
          });
    });
  }

	/**
	 * Creates a call to phone a number.
	 * The call object is created under application.calls when the call has started.
	 * listen for it with application.on("call:status:changed")
	 *
	 * You don't need to start the stream, the SDK will play the audio for you
	 *
	 * @classdesc creates a call to a phone number
   * @param {string} user the phone number or the username you want to call
   * @param {string} [type="phone"] the type of the call you want to have. possible values "phone" or "app" (default is "phone")
	 * @returns {Promise<NXMCall>}
	 * @example <caption>Create a call to a phone</caption>
	 *        application.on("call:status:changed", (nxmCall) => {
			if (nxmCall.status === nxmCall.CALL_STATUS.STARTED) {
				console.log('the call has started');
	 *		}
	 * application.callServer(phone_number).then(() => {
	 *                 console.log('Calling phone ' + phone_number);
	 *      });
	*/
  callServer(user, type = 'phone') {
    return new Promise((resolve, reject) => {
      const nxmCall = new NXMCall(this);
      nxmCall.direction = nxmCall.CALL_DIRECTION.OUTBOUND;
      return nxmCall.createServerCall(user, type)
          .then(({id}) => {
            nxmCall.knocking_id = id;
            this._call_draft_list.set(nxmCall.knocking_id, nxmCall);
            return resolve(nxmCall);
          });
    });
  }

	/**
	 * Query the service to create a new conversation
	 * The conversation name must be unique per application.
	 * @param {object} [params] - leave empty to get a GUID as name
	 * @param {string} params.name - the name of the conversation. A UID will be assigned if this is skipped
	 * @param {string} params.display_name - the display_name of the conversation.
	 * @returns {Promise<Conversation>} - the created Conversation
	 * @example <caption>Create a conversation and join</caption>
	 * application.newConversation().then((conversation) => {
	 *
	 *         //join the created conversation
	 *         conversation.join().then((member) => {
	 *             //Get the user's member belonging in this conversation.
	 *             //You can also access it via conversation.me
	 *
	 *                 console.log("Joined as " + member.user.name);
	 *             });
	 *
	 *     }).catch((error) => {
	 *     console.log(error);
	 * });
	*/
  newConversation(data = {}) {
    return new Promise((resolve, reject) => {
      return this.session.sendNetworkRequest({
        type: 'POST',
        path: 'conversations',
        data
      }).then((response) => {
        const conv = new Conversation(this, response);
        this.conversations.set(conv.id, conv);
        // do a get conversation to get the whole model as shaped in the service,
        this.getConversation(conv.id).then((conversation) => {
          resolve(conversation);
        });
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

	/**
	 * Query the service to create a new conversation and join it
	 * The conversation name must be unique per application.
	 * @param {object} [params] - leave empty to get a GUID as name
	 * @param {string} params.name - the name of the conversation. A UID will be assigned if this is skipped
	 * @param {string} params.display_name - the display_name of the conversation.
	 * @returns {Promise<Conversation>} - the created Conversation
	 * @example <caption>Create a conversation and join</caption>
	 * application.newConversationAndJoin().then((conversation) => {
	 *         //join the created conversation
	 *         conversation.join().then((member) => {
	 *             //Get the user's member belonging in this conversation.
	 *             //You can also access it via conversation.me
	 *                 console.log("Joined as " + member.user.name);
	 *             });
	 *     }).catch((error) => {
	 *     console.log(error);
	 * });
	*/
  newConversationAndJoin(params) {
    return this.newConversation(params).then((conversation) => {
      return conversation.join().then(() => {
        return conversation;
      });
    });
  }

	/**
	 * Query the service to see if this conversation exists with the
	 * logged in user as a member and retrieve the data object
	 * Result added (or updated) in this.conversations
	 *
	 * @param {string} id - the id of the conversation to fetch
	 * @returns {Promise<Conversation>} - the requested conversation
	*/
  getConversation(id) {
    return new Promise((resolve, reject) => {
      return this.session.sendNetworkRequest({
        type: 'GET',
        path: `conversations/${id}`
      }).then((response) => {
        response['id'] = response['uuid'];
        delete response['uuid'];

        const conversation_object = this.updateOrCreateConversation(response);
        if (this.session.config.sync === 'full') {
          // Populate the events
          conversation_object.getEvents().then(({items}) => {
            conversation_object.events = items;
            resolve(conversation_object);
          });
        } else {
          resolve(conversation_object);
        }
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

	/**
	 * Query the service to obtain a complete list of conversations of which the
	 * logged-in user is a member with a state of `JOINED` or `INVITED`.
   * @param {object} params configure defaults for paginated conversations query
   * @param {string} params.order 'asc' or 'desc' ordering of resources based on creation time
   * @param {number} params.page_size the number of resources returned in a single request list
   * @param {string} [params.cursor] string to access the starting point of a dataset
	 *
	 * @returns {Promise<Page<Map<Conversation>>>} - Populate Application.conversations.
   * @example <caption>Get Conversations</caption>
   * application.getConversations({ page_size: 20 ).then((conversations_page) => {
   *     conversations_page.items.forEach(conversation => {
   *      render(conversation)
   *   })
   * });
   *
	*/
  getConversations(params = {}) {
    const url = `${this.session.config.nexmo_api_url}/beta2/users/${this.me.id}/conversations`;

    // Create pageConfig if some elements given otherwise use default
    let pageConfig = Object.keys(params).length === 0 ? this.pageConfig : new PageConfig(params);

    return new Promise((resolve, reject) => {
      return Utils.paginationRequest(url, pageConfig)
          .then((response) => {
            response.application = this;
            const conversations_page = new ConversationsPage(response);
            this.conversations_page_last = conversations_page;
            resolve(conversations_page);
          }).catch((error) => reject(new NexmoApiError(error)));
    });
  }

  /**
   * Application listening sync status.
   *
   * @event Application#sync:progress
   *
   * @property {number} status.sync_progress - Percentage of fetched conversations
   * @example <caption>listening for changes in the synchronisation progress</caption>
   *  application.on("sync:progress",(status) => {
   *			console.log(data.sync_progress);
  *       });
  *  });
  */

  /**
   * Fetching all the conversations and sync progress events
  */
  syncConversations(conversations) {
    const conversation_array = Array.from(conversations.values());
    const conversations_length = conversation_array.length;

    const d = new Date();
    this.start_sync_time = (typeof window !== 'undefined' && window.performance) ? window.performance.now() : d.getTime();

    const fetchConversationForStorage = () => {
      this.synced_conversations_percentage = ((this.synced_conversations_count / conversations_length) * 100).toFixed(2);

      const status_payload = {
        sync_progress: this.synced_conversations_percentage
      };
      this.emit('sync:progress', status_payload);

      this.log.debug('Loading sync progress: ' + this.synced_conversations_count + '/' +
        conversations_length + ' - ' + this.synced_conversations_percentage + '%');
      if (this.synced_conversations_percentage >= 100) {
        const d = new Date();
        this.stop_sync_time = (typeof window !== 'undefined' && window.performance) ? window.performance.now() : d.getTime();
        this.log.info('Loaded conversations in ' + (this.stop_sync_time - this.start_sync_time) + 'ms');
      }
      if (this.synced_conversations_count < conversations_length) {
        this.getConversation(conversation_array[this.synced_conversations_count].id).then(() => {
          fetchConversationForStorage();
        });
        this.synced_conversations_count++;
        this.sync_progress_buffer++;
      }
    };
    fetchConversationForStorage();
  }

	/**
	 * Get Details of a user
	 * @param {string} [id] - the id of the user to fetch, if skipped, it returns your own user details
	 * @returns {Promise<User>}
	*/
  getUser(user_id = this.me.id) {
    return new Promise((resolve, reject) => {
      return this.session.sendNetworkRequest({
        type: 'GET',
        path: `users/${user_id}`
      }).then((response) => {
        resolve(new User(this, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }
}

module.exports = Application;

},{"./conversation":2,"./handlers/application_events":6,"./handlers/rtc_events":8,"./handlers/sip_events":9,"./modules/nxmCall":15,"./nexmoClientError":20,"./pages/conversations_page":22,"./pages/page_config":25,"./user":27,"./utils":28,"loglevel":52,"wildemitter":100}],2:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  Conversation Object Model
 *
 * Copyright (c) Nexmo Inc.
 */

const WildEmitter = require('wildemitter');
const getLogger = require('loglevel').getLogger;
const Member = require('./member');
const NXMEvent = require('./events/nxmEvent');
const TextEvent = require('./events/text_event');
const Media = require('./modules/media');
const ConversationEventHandler = require('./handlers/conversation_events');
const NexmoClientError = require('./nexmoClientError').NexmoClientError;
const NexmoApiError = require('./nexmoClientError').NexmoApiError;
const Utils = require('./utils');
const PageConfig = require('./pages/page_config');
const EventsPage = require('./pages/events_page');

/**
 * A single conversation Object.
 * @class Conversation
 * @property {Member} me - my Member object that belongs to this conversation
 * @property {Application} application - the parent Application
 * @property {string} name - the name of the Conversation (unique)
 * @property {string} [display_name] - the display_name of the Conversation
 * @property {Map<string, Member>} [members] - the members of the Conversation keyed by a member's id
 * @property {Map<string, NXMEvent>} [events] - the events of the Conversation keyed by an event's id
 * @property {number} [sequence_number] - the last event id
*/
class Conversation {
  constructor(application, params) {
    this.log = getLogger(this.constructor.name);
    this.application = application;
    this.id = null;
    this.name = null;
    this.display_name = null;
    this.timestamp = null;
    this.members = new Map();
    this.events = new Map();
    this.sequence_number = 0;
    this.is_video_conversation = false;
    this.pageConfig = new PageConfig(((this.application.session || {}).config || {}).events_page_config);
    this.events_page_last = null;

    this.conversationEventHandler = new ConversationEventHandler(application, this);

    this.media = new Media(this);
    /**
     * A Member Object representing the current user.
     * Only set if the user is or has been a member of the Conversation,
     * otherwise the value will be `null`.
     * @type Member
    */
    this.me = null; // We are not in the conversation ourselves by default

    // Map the params (which includes the id)
    this._updateObjectInstance(params);
    WildEmitter.mixin(Conversation);
  }

	/** Update Conversation object params
	 * @property {object} params the params to update
	 * @private
	*/
  _updateObjectInstance(params) {
    for (let key in params) {
      switch (key) {
        case 'id':
          this.id = params.id;
          break;
        case 'name':
          this.name = params.name;
          break;
        case 'display_name':
          this.display_name = params.display_name;
          break;
        case 'members':
          // update the conversation javascript object

          // CASE 1 conversations:get:success,
          // PATCH this responds with member[0].user_id and name

          // Iterate the list
          params.members.map((m) => {
            if (this.members.has(m.member_id)) {
              this.members.get(m.member_id)._normalise(m);
              if (m.user_id === this.application.me.id && m.state !== 'LEFT') {
                this.me = this.members.get(m.member_id);
                this.members.set(this.me.id, this.me);
              }
            } else {
              const member = new Member(this, m);
              if (m.user_id === this.application.me.id && m.state !== 'LEFT') {
                this.me = member;
              }
              this.members.set(member.id, member);
            }
          });
          break;
        case 'timestamp':
          this.timestamp = params.timestamp;
          break;
        case 'sequence_number':
          this.sequence_number = params.sequence_number;
          break;
        case 'member_id':
          // filter needed params to create the object
          // the conversation list gives us the member_id to prepare the member/this object
          const object_params = {
            id: params.member_id,
            state: params.state,
            user: this.application.me
          };

          // update the member object or create a new instance
          if (this.members.has(params.member_id)) {
            const member_object = this.members.get(params.member_id);
            Object.assign(member_object, object_params);
          } else {
            const member = new Member(this, object_params);
            this.me = member;
            this.members.set(member.id, member);
          }
          break;
        case 'properties':
          this.is_video_conversation = params.properties.video;
          break;
      }
    }
  }

  /**
   * Join the given user to this conversation, will typically use this to join
   * ourselves to a conversation we create.
   * Accept an invitation if our member has state INVITED and no user_id / user_name is given
   *
   * @param {object} [params = this.application.me.id] The user to join (defaults to this)
   * @param {string} params.user_name the user_name of the user to join
   * @param {string} params.user_id the user_id of the user to join
   * @returns {Promise<Member>}
   *
   * @example <caption>join a user to a conversation</caption>
   *
   *  conversation.join().then((member) => {
   *    console.log("joined as member: ", member)
   *  })
  */
  join(params) {
    const request_body = {};
    const _createDefaultValues = (params) => {
      if (params) {
        if (params.user_id) {
          request_body.user_id = params.user_id;
        }
        if (params.user_name) {
          request_body.user_name = params.user_name;
        }
      } else {
        if (this.me && this.me.id && this.me.state === 'INVITED') {
          request_body.member_id = this.me.id;
        }
        request_body.user_name = this.application.me.name;
        request_body.user_id = this.application.me.id;
      }
      return request_body;
    };

    return new Promise((resolve, reject) => {
      let data = _createDefaultValues(params);
      data.action = 'join';
      data.channel = {
        type: 'app'
      };

      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.id}/members`,
        data
      }).then((response) => {
        const member = new Member(this, response);
        if (response.user_id === this.application.me.id) {
          this.me = member;
        }
        this.members.set(member.id, member);
        // use case where between the time we got the conversation and the time we finished joining
        // the conversation object changed.
        return this.application.getConversation(this.id)
            .then(() => resolve(member))
            .catch(() => {
              this.log.warn('Failed getting conversation after joining');
              return resolve(member);
            });
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Delete a conversation
   * @returns {Promise}
   * @example <caption>delete the conversation</caption>
   *
   *    conversation.del().then(() => {
   * 		  console.log("conversation deleted");
   * 		})
  */
  del() {
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'DELETE',
        path: `conversations/${this.id}`
      }).then((response) => {
        this.application.conversations.delete(this.id);
        resolve(response);
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

	/**
	 * Delete an NXMEvent (e.g. Text)
	 * @param {NXMEvent} event
	 * @returns {Promise}
	 *
	*/
  deleteEvent(event) {
    return event.del();
  }

  /**
    * Invite the given user (id or name) to this conversation
    * @param {Member} params
    * @param {string} [params.id or username] - the id or the username of the user to invite
    *
    * @returns {Promise<Member>}
    *
    * @example <caption>invite a user to a conversation</caption>
    *  const user_id = 'user to invite';
    *  const user_name = 'username to invite';
    *
    *  conversation.invite({
    *          id: user_id,
    *          user_name: user_name
    *  })
    *        .then((member) => {
    *            displayMessage(member.state + " user: " + user_id + " " + user_name);
    *       }).catch((error) => {
    *          console.log(error);
    *  });
    *
  */
  invite(params) {
    if (!params || (!params.id && !params.user_name)) {
      return Promise.reject(new NexmoClientError('error:invite:missing:params'));
    }
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.id}/members`,
        data: {
          action: 'invite',
          user_id: params.id,
          user_name: params.user_name,
          member_id_inviting: this.me.id,
          media: params.media,
          channel: {
            from: {type: 'app'},
            leg_ids: [],
            leg_settings: {},
            legs: [],
            to: {type: 'app'},
            type: 'app'
          }
        }
      }).then((response) => {
        const member = new Member(this, response);
        this.members.set(member.id, member);
        resolve(member);
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
    * Invite the given user (id or name) to this conversation with media audio
    * @param {Member} params
    * @param {string} [params.id or username] - the id or the username of the user to invite
    *
    * @returns {Promise<Member>}
    *
    * @example <caption>invite a user to a conversation</caption>
    *  const user_id = 'user to invite';
    *  const user_name = 'username to invite';
    *
    *  conversation.inviteWithAudio({
    *          id: user_id,
    *          user_name: user_name
    *      })
    *        .then((member) => {
    *            displayMessage(member.state + " user: " + user_id + " " + user_name);
    *       }).catch((error) => {
    *          console.log(error);
    *  });
    *
  */
  inviteWithAudio(params) {
    if (!params || (!params.id && !params.user_name)) {
      return Promise.reject(new NexmoClientError('error:invite:missing:params'));
    }
    params.media = {
      audio_settings: {
        enabled: true,
        muted: false,
        earmuffed: false
      }
    };

    return this.invite(params);
  }

	/**
	 * Leave from the conversation
   * @param {object} [reason] the reason for leaving the conversation
   * @param {string} [reason.reason_code] the code of the reason
   * @param {string} [reason.reason_text] the description of the reason
	 * @returns {Promise}
	*/
  leave(reason) {
    return this.me.kick(reason);
  }

  /**
    * Send a text message to the conversation, which will be relayed to every other member of the conversation
    * @param {string} text - the text message to be sent
    *
    * @returns {Promise<TextEvent>} - the text message that was sent
    *
    * @example <caption> sending a text </caption>
    *    conversation.sendText("Hi Nexmo").then(() => {
    *			console.log('message was sent');
    *		}).catch((error)=>{
    *			console.log('error sending the message', error);
    *	});
    *
  */
  sendText(text) {
    return new Promise((resolve, reject) => {
      if (this.me === null) {
        reject(new NexmoClientError('error:self'));
      } else {
        const msg = {
          type: 'text',
          cid: this.id,
          from: this.me.id,
          body: {
            text
          }
        };

        return this.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.id}/events`,
          data: msg
        }).then(({id, timestamp}) => {
          msg.id = id;
          msg.body.timestamp = timestamp;
          const text_event = new TextEvent(this, msg);
          resolve(text_event);
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }

  /**
    * Send a custom event to the conversation
    * @param {object} params - params of the custom event
    * @param {string} type - the name of the custom event. Must not exceed 100 char length and contain only alpha numerics and '-' and '_' characters.
    * @param {object} body - customizable key value pairs
    *
    * @returns {Promise<NXMEvent>} - the custom event that was sent
    *
    * @example <caption> sending a custom event </caption>
    *    conversation.sendCustomEvent({ type: 'my-event', body: {}}).then(() => {
    *			console.log('custom event was sent');
    *		}).catch((error)=>{
    *			console.log('error sending the custom event', error);
    *	});
    *
  */
  sendCustomEvent({type, body}) {
    return new Promise((resolve, reject) => {
      if (this.me === null) {
        reject(new NexmoClientError('error:self'));
      } else if (!type || typeof type !== 'string' || type.length < 1) {
        reject(new NexmoClientError('error:custom-event:invalid'));
      } else {
        const data = {
          type: `custom:${type}`,
          cid: this.id,
          from: this.me.id,
          body
        };

        return this.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.id}/events`,
          data
        }).then(({id, timestamp}) => {
          data.id = id;
          data.timestamp = timestamp;
          const custom_event = new NXMEvent(this, data);
          resolve(custom_event);
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }

  /**
   * Send an Image message to the conversation, which will be relayed to every other member of the conversation.
   * implements xhr (https://xhr.spec.whatwg.org/) - this.imageRequest
   *
   * @param {File} file single input file (jpeg/jpg)
   * @param {string} [params.quality_ratio = 100] a value between 0 and 100. 0 indicates 'maximum compression' and the lowest quality, 100 will result in the highest quality image
   * @param {string} [params.medium_size_ratio = 50] a value between 1 and 100. 1 indicates the new image is 1% of original, 100 - same size as original
   * @param {string} [params.thumbnail_size_ratio = 10] a value between 1 and 100. 1 indicates the new image is 1% of original, 100 - same size as original
   *
   * @returns {Promise<XMLHttpRequest>}
   *
   * @example <caption>sending an image</caption>
   * conversation.sendImage(fileInput.files[0]).then((imageRequest) => {
   *         imageRequest.onabort = (e) => {
   *            console.log(e);
   *          console.log("Image:" + e.type);
   *      };
   *          imageRequest.onloadend = (e) => {
   *          console.log("Image:" + e.type);
   *      };
   * });
  */
  sendImage(fileInput, params = {
    quality_ratio: 100,
    medium_size_ratio: 50,
    thumbnail_size_ratio: 30
  }) {
    const formData = new FormData();
    formData.append('file', fileInput);
    formData.append('quality_ratio', params.quality_ratio);
    formData.append('medium_size_ratio', params.medium_size_ratio);
    formData.append('thumbnail_size_ratio', params.thumbnail_size_ratio);

    return Utils.networkRequest({
      type: 'POST',
      url: this.application.session.config.ips_url,
      data: formData
    }).then((imageRequest) => {
      imageRequest.upload.addEventListener('progress', (evt) => {
        if (evt.lengthComputable) {
          this.log.debug('uploading image ' + evt.loaded + '/' + evt.total);
        }
      }, false);

      imageRequest.onreadystatechange = () => {
        if (imageRequest.readyState === 4 && imageRequest.status === 200) {
          this.application.session.sendNetworkRequest({
            type: 'POST',
            path: `conversations/${this.id}/events`,
            data: {
              type: 'image',
              from: this.me.id,
              body: {
                representations: JSON.parse(imageRequest.responseText)
              }
            }
          }).then((response) => {
            this.log.info(imageRequest);
          }).catch((error) => {
            this.log.debug(new NexmoApiError(error));
          });
        }
        if (imageRequest.status !== 200) {
          this.log.error(imageRequest);
        }
      };

      return Promise.resolve(imageRequest);
    });
  }

	/**
	 * Cancel sending an Image message to the conversation.
	 *
	 * @param {XMLHttpRequest} imageRequest
	 *
	 * @returns void
	 *
	 * @example <caption>cancel sending an image</caption>
	 * conversation.sendImage(fileInput.files[0]).then((imageRequest) => {
	 *    conversation.abortSendImage(imageRequest);
	 * });
	*/
  abortSendImage(imageRequest) {
    if (imageRequest instanceof XMLHttpRequest) {
      return imageRequest.abort();
    } else {
      return new NexmoClientError('error:invalid:param:type');
    }
  }

  _typing(state) {
    const params = {
      activity: (state === 'on') ? 1 : 0
    };
    const data = {
      type: 'text:typing:' + state,
      cid: this.id,
      from: this.me.id,
      body: params
    };

    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.id}/events`,
        data
      }).then((response) => {
        resolve(`text:typing:${state}:success`);
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Send start typing indication
   *
   * @returns {Promise} - resolves the promise on successful sent
  */
  startTyping() {
    return this._typing('on');
  }

  /**
   * Send stop typing indication
   *
   * @returns {Promise} - resolves the promise on successful sent
  */
  stopTyping() {
    return this._typing('off');
  }

  /**
    * Query the service to get a list of events in this conversation.
    *
    * @param {object} params configure defaults for paginated events query
    * @param {string} params.order 'asc' or 'desc' ordering of resources based on creation time
    * @param {number} params.page_size the number of resources returned in a single request list
    * @param {string} [params.cursor] string to access the starting point of a dataset
    * @param {string} [params.event_type] the type of event used to filter event requests. Supports wildcard options with :* eg. 'members:*'
    *
    * @returns {Promise<EventsPage<Map<Events>>>} - Populate Conversations.events.
    * @example <caption>Get Events</caption>
    * conversation.getEvents({ event_type: 'member:*' ).then((events_page) => {
    *     events_page.items.forEach(event => {
    *      render(event)
    *   })
    * });
  */
  getEvents(params = {}) {
    const url = `${this.application.session.config.nexmo_api_url}/beta2/conversations/${this.id}/events`;

    // Create pageConfig if given params otherwise use default
    let pageConfig = Object.keys(params).length === 0 ? this.pageConfig : new PageConfig(params);

    return new Promise((resolve, reject) => {
      return Utils.paginationRequest(url, pageConfig)
          .then((response) => {
            response.application = this.application;
            response.conversation = this;
            const events_page = new EventsPage(response);
            this.events_page_last = events_page;
            resolve(events_page);
          }).catch((error) => reject(new NexmoApiError(error)));
    });
  }

	/**
	 * Handle and event from the cloud.
	 * using conversationEventHandler
	 * @param {object} event
	 * @private
	*/
  _handleEvent(event) {
    if (event.type.startsWith('rtc')) {
      // keep the rtc events going to the application layer, we use them in media module
      this.emit(event.type, event);
      return;
    }
    this.sequence_number++;
    if (event.from && !this.members.has(event.from)) {
      this.members.set(event.from, new Member(this, event));
    }
    // make sure the event_id is not a string
    if (event.body && event.body.event_id && typeof event.body.event_id === 'string') {
      event.body.event_id = parseInt(event.body.event_id);
    }
    const from = this.members.get(event.from);
    let constructed_event = this.conversationEventHandler.handleEvent(event);
    // Unless they are typing events, add the event to the conversation.events map
    if (!['text:typing:on', 'text:typing:off'].includes(event.type)) {
      this.events.set(constructed_event.id, constructed_event);
    }
    // For custom events remove the custom: prefix before emitting event
    if (event.type.startsWith('custom:')) {
      this.emit(constructed_event.type, from, constructed_event);
      return;
    }

    this.emit(event.type, from, constructed_event);
  }
}

module.exports = Conversation;

},{"./events/nxmEvent":4,"./events/text_event":5,"./handlers/conversation_events":7,"./member":11,"./modules/media":14,"./nexmoClientError":20,"./pages/events_page":23,"./pages/page_config":25,"./utils":28,"loglevel":52,"wildemitter":100}],3:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  ImageEvent Object Model
 *
 * Copyright (c) Nexmo Inc.
 */

const getLogger = require('loglevel').getLogger;
const NXMEvent = require('./nxmEvent');
const networkRequest = require('./../utils').networkRequest;

/**
 * An image event
 *
 * @class ImageEvent
 * @extends NXMEvent
*/
class ImageEvent extends NXMEvent {
  constructor(conversation, params) {
    super(conversation, params);
    this.log = getLogger(this.constructor.name);
    this.type = 'image';
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
   */
  seen() {
    return super.seen();
  }

  /**
   * Set the message status to 'delivered'
   */
  delivered() {
    return super.delivered();
  }

  /**
   * Delete the image event, all 3 representations of it
   * passing only the one of the three URLs
   * @param {object} [imageRepresentations=this.body.representations] the ImageEvent.body for the image to delete
   * @returns {Promise}
   */
  del(imageRepresentations = this.body.representations) {
    return networkRequest({
      type: 'DELETE',
      url: imageRepresentations.original.url
    }).then(() => {
      return super.del();
    });
  }

  /**
   * Download an Image from Media service //3 representations
   * @param {string} [type="thumbnail"] original, medium, thumbnail,
   * @param {string} [representations=this.body.representations]  the ImageEvent.body for the image to download
   * @returns {string} the dataUrl "data:image/jpeg;base64..."
   * @example <caption>Downloading an image from the imageEvent</caption>
   *                 imageEvent.fetchImage().then((imagedata) => {
   *                      var img = new Image();
   *                      img.onload = function () {
   *                      };
   *                      img.src = imagedata;
   *
   *                      // to cancel the request:
   *                      // conversation.abortSendImage(imageRequest);
   *                  });
  */
  fetchImage(type = 'thumbnail', imageRepresentations = this.body.representations) {
    return networkRequest({
      type: 'GET',
      url: imageRepresentations[type].url,
      responseType: 'arraybuffer'
    }).then(({response}) => {
      const responseArray = new Uint8Array(response);
      // Convert the int array to a binary String
      // We have to use apply() as we are converting an *array*
      // and String.fromCharCode() takes one or more single values, not
      // an array.
      // support large image files (Chunking)
      let res = '';
      const chunk = 8 * 1024;

      for (let i = 0; i < responseArray.length / chunk; i++) {
        res += String.fromCharCode.apply(null, responseArray.subarray(i * chunk, (i + 1) * chunk));
      }

      res += String.fromCharCode.apply(null, responseArray.subarray(i * chunk));
      const b64 = btoa(res);
      const dataUrl = 'data:image/jpeg;base64,' + b64;

      return Promise.resolve(dataUrl);
    });
  }
}

module.exports = ImageEvent;

},{"./../utils":28,"./nxmEvent":4,"loglevel":52}],4:[function(require,module,exports){
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

},{"../nexmoClientError":20,"wildemitter":100}],5:[function(require,module,exports){
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

},{"./nxmEvent":4}],6:[function(require,module,exports){
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

},{"../events/nxmEvent":4,"../modules/nxmCall":15,"../utils":28,"loglevel":52}],7:[function(require,module,exports){
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

},{"../events/image_event":3,"../events/nxmEvent":4,"../events/text_event":5,"loglevel":52}],8:[function(require,module,exports){
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

},{"loglevel":52}],9:[function(require,module,exports){
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

},{"loglevel":52}],10:[function(require,module,exports){
(function (global){
'use strict';

let NexmoClient = global.NexmoClient || {};
NexmoClient = require('./sdk');

global.NexmoClient = NexmoClient;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./sdk":26}],11:[function(require,module,exports){
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

},{"./events/nxmEvent":4,"./nexmoClientError":20,"./utils":28,"wildemitter":100}],12:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
 */

const NexmoClientError = require('../nexmoClientError').NexmoClientError;
const SCREEN_SHARE_INSTALLED_MESSAGE = 'screenshare-extension-installed';

/**
 * Access Chrome specific screenShare plugin.
 * @class ChromeHelper
 * @private
*/
class ChromeHelper {
  constructor(screenShareExtensionId) {
    this.screenShareExtensionId = screenShareExtensionId;
  }

  checkScreenShareInstalled() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(this.screenShareExtensionId, SCREEN_SHARE_INSTALLED_MESSAGE, (response) => {
        if (response && response.type === 'success' && response.version === '0.1.0') {
          resolve();
        } else {
          reject(new NexmoClientError('error:media:extension-not-installed'));
        }
      });
    });
  }

  getScreenShare(sources) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(this.screenShareExtensionId, {sources: sources}, (response) => {
        if (!response || response.type === 'error') {
          reject(new NexmoClientError('error:media:extension'));
        } else if (response.type === 'success') {
          resolve(response.streamId);
        } else {
          reject(new NexmoClientError('error:media:extension'));
        }
      });
    });
  }
}

module.exports = ChromeHelper;

},{"../nexmoClientError":20}],13:[function(require,module,exports){
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

},{"../nexmoClientError":20,"loglevel":52}],14:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  Media Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const RtcHelper = require('./rtc_helper');
const TraceWS = require('./rtcstats/trace-ws');
const RTCStats = require('./rtcstats/rtcstats');
const getLogger = require('loglevel').getLogger;
const Utils = require('../utils');
const NXMEvent = require('../events/nxmEvent');
const NexmoClientError = require('../nexmoClientError').NexmoClientError;
const NexmoApiError = require('../nexmoClientError').NexmoApiError;

/**
 * Member listening for audio stream on.
 *
 * @event Member#media:stream:on
 *
 * @property {number} payload.streamIndex the index number of this stream
 * @property {number} [payload.rtc_id] the rtc_id / leg_id
 * @property {string} [payload.remote_member_id] the id of the Member the stream belongs to
 * @property {string} [payload.name] the stream's display name
 * @property {MediaStream} payload.stream the stream that is activated
 * @property {boolean} [payload.video_mute] if the video is hidden
 * @property {boolean} [payload.audio_mute] if the audio is muted
*/

/**
 * Member listening for rtc connection fail.
 *
 * @event Member#media:connection:fail
 *
 * @property {number} payload.rtc_id the rtc_id / leg_id
 * @property {string} payload.remote_member_id the id of the Member the stream belongs to
 * @property {event} payload.connection_event the connection fail event
 * @property {number} payload.streamIndex the streamIndex of the specific stream
 * @property {string} payload.type the type of the connection (video or screenshare)
*/

/**
 * WebRTC Media class
 * @class Media
 * @property {Application} application The parent application object
 * @property {Conversation} parentConversation the conversation object this media instance belongs to
 * @property {Member[]} parentConversation.remoteMembers The remote members
 * @property {number} parentConversation.streamIndex the latest index of the streams, updated in each new peer offer
 * @property {object[]} rtcObjects data related to the rtc connection
 * @property {string} rtcObjects.rtc_id the rtc_id
 * @property {PeerConnection} rtcObjects.pc the current PeerConnection object
 * @property {Stream} rtcObjects.stream the stream of the specific rtc_id
 * @property {string} [rtcObjects.type] audio|video|screenshare the type of the stream
 * @property {number} rtcObjects.streamIndex the index number of the stream (e.g. use to mute)
 * @emits Application#rtcstats:report
 * @emits Member#media:stream:on
 */
class Media {
  constructor(conversation) {
    this.log = getLogger(this.constructor.name);
    if (conversation) {
      this.rtcHelper = new RtcHelper();
      this.application = conversation.application;
      this.application.activeStreams = this.application.activeStreams || [];
      this._eventsQueue = [];
      this.parentConversation = conversation;
      this.parentConversation.remoteMembers = [];
      this.rtcObjects = {};
      this.streamIndex = 0;
      this.rtcstats_conf = {};
      this.rtcStats = null;
      if (this.application.session.config && this.application.session.config.rtcstats) {
        this.rtcstats_conf = {
          emit_events: this.application.session.config.rtcstats.emit_events,
          ws_url: this.application.session.config.rtcstats.ws_url
        };
      }
      if (this.application.session.config && this.application.session.config.screenShareExtensionId && this.application.session.config.screenShareExtensionId !== '') {
        this.rtcHelper._setScreenShareExtensionId(this.application.session.config.screenShareExtensionId);
      }
      if (this.rtcstats_conf.emit_events) {
        this._initStatsReporting();
      }
    } else {
      this.log.warn('No conversation object in Media');
    }
  }

  _attachEndingEventHandlers() {
    this.log.debug('attaching leave listeners in media for ' + this.parentConversation.id);
    this.parentConversation.on('rtc:terminate', (event) => {
      this._handleParticipantRtcTerminate(event);
    });

    this.parentConversation.on('rtc:hangup', (event) => {
      const member = this.parentConversation.members.get(event.from);
      if (member.user.id === this.application.me.id && (this.application.activeStreams.length)) {
        this._cleanMediaProperties();
      }
    });

    this.parentConversation.on('member:left', (member) => {
      this._handleMemberLeft(member);
    });
  }

  /**
   * Application listening for RTC stats.
   *
   * @event Application#rtcstats:report
   *
   * @property {number} MOS - the calculated MOS score
   * @property {Object} report - the stats report from WebRTC | when the call has ended this is null, see the mos_report for final MOS summary
   * @property {Conversation} Conversation - the conversation the report belongs to
   * @property {Object} mos_report - a report for the MOS values
   * @property {string} mos_report.min - the minimum MOS value during the stream
   * @property {string} mos_report.max - the maximum MOS value during the stream
   * @property {string} mos_report.last - the last MOS value during the stream
   * @property {string} mos_report.average - the average MOS value during the stream
   *
   * @example <caption>listening for quality mos score</caption>
   *  application.on("rtcstats:report",(mos, report, conversation, mos_report) => {
   *              console.log("call quality (MOS)", mos);
   *              if (mos_report) {
   *              console.log('mos_report', mos_report);
   *               }
   *           });
  */
  _enableCallStats(pc) {
    this.application.session.callstats.addNewFabric(pc, this.parentConversation.me.id, 'audio', this.parentConversation.id);
  }

  /**
   * Switch on the rtcStat reporting to the websocket connection and events
   * @param ws_url
   * @private
  */
  _enableStatsReporting(ws_url) {
    this.application.session.config.rtcstats.ws_url = ws_url;
    this.rtcstats_conf.ws_url = ws_url;
    this._initStatsReporting();
  }

  /**
   * Switch on the rtc stats emit events
   * @private
  */
  _enableStatsEvents() {
    this.application.session.config.rtcstats.emit_events = true;
    this.rtcstats_conf.emit_events = true;
    this._initStatsEvents();
  }

  _initStatsReporting() {
    if (!this.rtcHelper.isNode() && !this.rtcStats && this.application.session.config.rtcstats.ws_url) {
      this.rtcStats_wsConnection = new TraceWS();
      this.rtcStats = new RTCStats(
          this.rtcStats_wsConnection.trace,
          false, // isCallback
          1000, // interval at which getStats will be polled,
          [''] // RTCPeerConnection prefixes to wrap.
      );
      this.rtcStats_wsConnection.init({
        rtcstatsUri: this.application.session.config.rtcstats.ws_url
      });
    }
  }

  _initStatsEvents() {
    if (!this.rtcHelper.isNode() && !this.rtcStats) {
      const emit_event = (type, mos, report, mos_report) => {
        if (type === 'mos') {
          if (mos) {
            this.application.emit('rtcstats:report', mos, report, this.parentConversation);
          }
        } else if (type === 'mos_report') {
          this.application.emit('rtcstats:report', mos, null, this.parentConversation, mos_report);
        }
      };
      this.rtcStats = new RTCStats(
          emit_event,
          true, // isCallback
          1000, // interval at which getStats will be polled,
          [''] // RTCPeerConnection prefixes to wrap.
      );
    }
  }

  /**
   * Switch off the rtcStat reporting
   * @private
  */
  _disableStatsReporting() {
    this.application.session.config.rtcstats.ws_url = '';
    this.rtcstats_conf.ws_url = '';
    this.rtcStats_wsConnection.disable();
    delete this.rtcStats;
  }

  /**
   * Switch off the rtcStat events
   * @private
  */
  _disableStatsEvents() {
    this.application.session.config.rtcstats.emit_events = false;
    this.rtcstats_conf.emit_events = false;
    this.rtcStats.disable();
    delete this.rtcStats;
  }

  /**
   * Handles the enabling of audio only stream with rtc:new
   * @private
  */
  _handleAudio(params = {}) {
    return new Promise((resolve, reject) => {
      const onClientError = (error) => {
        this.log.error(error);
        reject(new NexmoClientError(error));
      };

      const streamIndex = this.streamIndex;
      this.streamIndex++;
      this.rtcHelper.getUserAudio(params.audioConstraints)
          .then((localStream) => {
            const clientId = Utils.allocateUUID();
            const pc_config = {
              'iceTransportPolicy': 'all',
              'bundlePolicy': 'balanced',
              'rtcpMuxPolicy': 'require',
              'iceCandidatePoolSize': '0'
            };
            if (this.application.session.config && this.application.session.config.iceServers) {
              pc_config.iceServers = this.application.session.config.iceServers;
            }
            const pc = this.rtcHelper.createRTCPeerConnection(pc_config, {
              optional: [{
                'DtlsSrtpKeyAgreement': 'true'
              }]
            }, clientId);

            pc.trace('conversation_id', this.parentConversation.id);
            pc.trace('member_id', this.parentConversation.me.id);

            if (this.application.session.config.callstats && this.application.session.config.callstats.enabled) {
              this._enableCallStats(pc);
            }

            this.pc = pc;
            pc.ontrack = (evt) => {
              this.application.activeStreams.push(evt.streams[0]);
              this.parentConversation.me.emit('media:stream:on', {
                pc: this.pc,
                stream: evt.streams[0],
                type: 'audio',
                streamIndex
              });
              resolve(evt.streams[0]);
            };

            pc.addStream(localStream);

            pc.onnegotiationneeded = () => {
              pc.createOffer()
                  .then((offer) => {
                    return pc.setLocalDescription(offer);
                  })
                  .catch(onClientError);
            };

            pc.oniceconnectionstatechange = (connection_event) => {
              switch (pc.iceConnectionState) {
              // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState
                case 'disconnected':
                  this.log.warn('One or more transports is disconnected', pc.iceConnectionState);
                  break;
                case 'failed':
                  onClientError(connection_event);
                  this.log.warn('One or more transports has terminated unexpectedly or in an error', connection_event);
                  break;
                default:
                  this.log.debug('The ice connection status changed', pc.iceConnectionState);
                  break;
              }
            };
            let gatheringTimer = null;
            let rtc_sent = false;
            pc.onicegatheringstatechange = () => {
              const do_gatherDone = () => {
                if (!this.pc) {
                  return;
                }

                this.application.session.sendNetworkRequest({
                  type: 'POST',
                  path: `conversations/${this.parentConversation.id}/rtc`,
                  data: {
                    from: this.parentConversation.me.id,
                    body: {
                      offer: this.pc.localDescription
                    }
                  }
                }).then((response) => {
                  const rtc_id = response.rtc_id;
                  pc.trace('rtc_id', rtc_id);
                  this.rtcObjects[rtc_id] = {
                    rtc_id,
                    pc,
                    stream: localStream,
                    type: 'audio',
                    streamIndex
                  };
                }).catch((error) => {
                  reject(new NexmoApiError(error));
                });
              };

              switch (pc.iceGatheringState) {
                case 'new':
                  this.log.debug('ice gathering new');
                  break;
                case 'complete':
                  window.clearTimeout(gatheringTimer);
                  gatheringTimer = null;
                  if (!rtc_sent) {
                    do_gatherDone();
                  }
                  this.log.debug('ice gathering complete');

                  break;
                case 'gathering':
                  gatheringTimer = setTimeout(() => {
                    do_gatherDone();
                    rtc_sent = true;
                  }, 2000);
                  this.log.debug('ice gathering gathering');
                  break;
              }
            };
          })
          .then(() => {
            // We want to be able to handle these events, for this  member, before they get propagated out
            this.parentConversation.once('rtc:answer', (event) => {
              if (!this.pc) {
                this.log.warn('RTC: received an answer too late');
                return;
              }
              this.pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: event.body.answer
              }),
              () => {
                this.log.debug('remote description is set');
              },
              onClientError);
            });
            this._attachEndingEventHandlers();
          })
          .catch((error) => {
            reject(new NexmoClientError(error));
          });
    });
  }


  _handleVideo(params) {
    return new Promise((resolve, reject) => {
      if (params.video) {
        let direction = 'none';
        let name = 'video';
        let videoConstraints;
        let audioConstraints;
        if (params.video === Object(params.video)) {
          direction = params.video.direction;
          name = params.video.name || 'video';
          videoConstraints = params.video.constraints;
        } else {
          direction = params.video;
        }
        if (params.audio) {
          audioConstraints = params.audio.constraints;
        }
        switch (direction) {
          case 'both':
          case 'send_only':
          case true:
            return this.rtcHelper.getUserVideo(videoConstraints, audioConstraints).then((localStream) => {
              this._handleVideoSend(localStream, direction === 'send_only', 'video', name, params);
              resolve(localStream);
            });
          case 'receive_only':
            this.log.debug('video - receive_only not implemented yet');
            reject(new NexmoApiError('Not implemented yet'));
            break;
          case 'none':
            resolve();
            break;
          default:
            if (direction === false) {
              let rtcObjectWithType = this._findRtcObjectByType('video');
              if (rtcObjectWithType) {
                resolve(this._disableLeg(rtcObjectWithType.rtc_id));
              } else {
                resolve();
              }
            } else {
              resolve();
            }
            break;
        }
      }
      resolve();
    }).then((localStream) => {
      return new Promise((resolve, reject) => {
        if (params.screenshare) {
          let direction = false;
          let name;
          let options = {
            sources: ['screen', 'window', 'tab']
          };
          if (params.screenshare === Object(params.screenshare)) {
            direction = params.screenshare.direction;
            name = params.screenshare.name || 'screenshare';
            options.sources = params.screenshare.sources || options.sources;
            options.sourceId = params.screenshare.sourceId || '';
          } else {
            direction = params.screenshare;
          }
          switch (direction) {
            case 'send_only':
            case true:
              return this.rtcHelper.getUserScreen(options).then((localStream) => {
                this._handleVideoSend(localStream, true, 'screenshare', name, params);
                resolve(localStream);
              });
            case 'none':
              resolve();
              break;
            default:
              if (direction === false) {
                let rtcObjectWithType = this._findRtcObjectByType('screenshare');
                if (rtcObjectWithType) {
                  resolve(this._disableLeg(rtcObjectWithType.rtc_id));
                } else {
                  resolve();
                }
              } else {
                resolve();
              }
              break;
          }
        } else {
          resolve(localStream);
        }
      });
    });
  }

  _emitEventsByRtcId(rtc_id) {
    this._eventsQueue.filter((event) => event.rtc_id === rtc_id)
        .forEach((event) => {
          event.func();
          event.ran = true;
        });
    this._eventsQueue = this._eventsQueue.filter((event) => event.ran === false);
  }

  _runWhenLegInitialized(rtc_id, func) {
    if (this.rtcObjects[rtc_id]) {
      func();
    } else {
      this._eventsQueue.push({
        rtc_id,
        func,
        ran: false
      });
    }
  }

  _handleVideoSend(localStream, isSendOnly, type, name, params) {
    let video_rtc_id = null;
    const clientId = Utils.allocateUUID();
    const pc = this.rtcHelper.createRTCPeerConnection({
      'iceServers': this.application.session.config.iceServers,
      'iceTransportPolicy': 'all',
      'bundlePolicy': 'balanced',
      'rtcpMuxPolicy': 'require',
      'iceCandidatePoolSize': '0'
    }, {
      optional: [{
        'DtlsSrtpKeyAgreement': 'true'
      }]
    }, clientId);

    pc.trace('conversation_id', this.parentConversation.id);
    pc.trace('member_id', this.parentConversation.me.id);

    if (this.application.session.config.callstats && this.application.session.config.callstats.enabled) {
      this._enableCallStats(pc);
    }

    // We want to be able to handle these events, for this  member, before they get propagated out
    if (!this.listeningToRtcEvent) {
      this.parentConversation.on('rtc:answer', (event) => {
        let setRemoveDescriptionFunc = () => {
          this.rtcObjects[event.body.rtc_id].pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: this.rtcHelper.editSDPOrder(pc.localDescription.sdp, event.body.answer)
          })).then(() => {
            this.log.debug('remote description is set');
          }).catch((e) => {
            this.log.warn('set remote description failed with error', e);
          });
        };
        this._runWhenLegInitialized(event.body.rtc_id, setRemoveDescriptionFunc);
      });
    }

    if (!isSendOnly && !this.listeningToRtcEvent) {
      this.parentConversation.on('rtc:offer', (event) => {
        let handleOfferFunc = () => {
          this._handleNewOffer(params, event);
        };
        this._runWhenLegInitialized(event.body.leg_id, handleOfferFunc);
      });
    }

    this.listeningToRtcEvent = true;
    pc.ontrack = (evt) => {
      this.log.debug('ontrack');
      this.application.activeStreams.push(evt.streams[0]);
    };

    pc.addStream(localStream);
    let streamIndex = this.streamIndex;
    this.streamIndex++;

    const p = new Promise((resolve, reject) => {
      pc.createOffer()
          .then((desc) => {
            return pc.setLocalDescription(desc);
          }).catch((e) => {
            return new NexmoApiError(e);
          });
    });

    pc.oniceconnectionstatechange = (connection_event) => {
      switch (pc.iceConnectionState) {
        // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState
        case 'disconnected':
          this.log.warn('One or more transports is disconnected', pc.iceConnectionState);
          break;
        case 'failed':
          this._onConnectionFail(
              this.parentConversation.me, {
                rtc_id: video_rtc_id,
                streamIndex: streamIndex,
                type: type,
                member_id: this.parentConversation.me.id,
                connection_event: connection_event
              });
          this.log.warn('One or more transports has terminated unexpectedly or in an error', connection_event);
          break;
        default:
          this.log.debug('The ice connection status changed', pc.iceConnectionState);
          break;
      }
    };

    const do_gatherDone = () => {
      if (!pc) return;

      const direction = isSendOnly ? 'send_only' : 'both';
      const event_to_emit = {
        type: 'rtc:new',
        cid: this.parentConversation.id,
        from: this.parentConversation.me.id,
        body: {
          offer: {
            sdp: pc.localDescription.sdp
          },
          video: {
            direction,
            name
          }
        }
      };

      this.application.session.sendRequest(event_to_emit, (response) => {
        if (response.type === 'rtc:new:success') {
          const rtc_id = response.body.rtc_id;
          video_rtc_id = rtc_id;
          pc.trace('rtc_id', rtc_id);
          this.rtcObjects[rtc_id] = {
            rtc_id: rtc_id,
            pc: pc,
            stream: localStream,
            type: type,
            streamIndex: streamIndex
          };
          this._emitEventsByRtcId(rtc_id);
          pc.trace('rtc_id', rtc_id);
          if (type === 'screenshare') {
            localStream.getVideoTracks()[0].onended = () => {
              this._disableLeg(rtc_id)
                  .then(() => {
                    this.parentConversation.me.emit('media:stream:off', streamIndex);
                  })
                  .catch(() => {
                    this.parentConversation.me.emit('media:stream:off', streamIndex);
                  });
            };
          }
          this.parentConversation.me.emit('media:stream:on', {
            type: type,
            name: name,
            streamIndex: streamIndex,
            stream: localStream
          });
        } else {
          return new NexmoApiError(response);
        }
      });

      if (params && params.label) {
        event_to_emit.label = params.label;
      }
    };

    let gatheringTimer = null;
    let rtc_sent = false;
    pc.onicegatheringstatechange = () => {
      switch (pc.iceGatheringState) {
        case 'new':
          this.log.debug('ice gathering new');
          break;
        case 'complete':
          window.clearTimeout(gatheringTimer);
          gatheringTimer = null;
          if (!rtc_sent) {
            do_gatherDone();
          }
          this.log.debug('ice gathering complete');
          break;
        case 'gathering':
          gatheringTimer = setTimeout(() => {
            do_gatherDone();
            rtc_sent = true;
          }, 2000);
          this.log.debug('ice gathering gathering');
          break;
      }
    };
    this._attachEndingEventHandlers();
    this.log.debug('sending local stream');

    return p;
  }

  _handleNewOffer(params, event) {
    const remoteMemberObject = {
      remote_member_id: event.body.member_id,
      remote_leg_id: event.body.member_leg_id,
      local_leg_id: event.body.leg_id,
      name: event.body.name,
      streamIndex: this.streamIndex
    };
    let streamIndex = this.streamIndex;
    this.streamIndex++;

    const video_mute = event.body.media_settings && event.body.media_settings.video ?
      event.body.media_settings.video.muted : false;
    const audio_mute = event.body.media_settings && event.body.media_settings.audio ?
      event.body.media_settings.audio.muted : false;

    for (let member of this.parentConversation.members.values()) {
      const member_id = member.id;
      if (member_id === event.body.member_id) {
        remoteMemberObject.remote_member = this.parentConversation.members.get(member_id);
      }
    }

    this.parentConversation.remoteMembers.push(remoteMemberObject);
    this.log.debug('handle rtc:offer for member ' + remoteMemberObject.remote_member_id);

    const clientId = Utils.allocateUUID();
    remoteMemberObject.pc = this.rtcHelper.createRTCPeerConnection({
      'iceServers': this.application.session.config.iceServers,
      'iceTransportPolicy': 'all',
      'bundlePolicy': 'balanced',
      'rtcpMuxPolicy': 'require',
      'iceCandidatePoolSize': '0'
    }, {
      optional: [{
        'DtlsSrtpKeyAgreement': 'true'
      }]
    }, clientId);

    if (this.application.session.config.callstats && this.application.session.config.callstats.enabled) {
      this._enableCallStats(pc);
    }

    remoteMemberObject.pc.trace('conversation_id', this.parentConversation.id);
    remoteMemberObject.pc.trace('member_id', this.parentConversation.me.id);
    remoteMemberObject.pc.trace('rtc_id', remoteMemberObject.local_leg_id);
    remoteMemberObject.pc.trace('other_member_id', remoteMemberObject.remote_member_id);

    remoteMemberObject.pc.ontrack = (evt) => {
      if (remoteMemberObject.stream !== evt.streams[0]) {
        remoteMemberObject.stream = evt.streams[0];
        remoteMemberObject.remote_member.emit('media:stream:on', {
          streamIndex: remoteMemberObject.streamIndex,
          rtc_id: remoteMemberObject.local_leg_id,
          remote_member_id: remoteMemberObject.remote_member_id,
          name: remoteMemberObject.name,
          stream: remoteMemberObject.stream,
          video_mute: video_mute,
          audio_mute: audio_mute
        });
      }
    };

    remoteMemberObject.pc.oniceconnectionstatechange = (connection_event) => {
      switch (remoteMemberObject.pc.iceConnectionState) {
        // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState
        case 'disconnected':
          this.log.warn('One or more transports is disconnected', remoteMemberObject.pc.iceConnectionState);
          break;
        case 'failed':
          this._onConnectionFail(
              remoteMemberObject.remote_member, {
                rtc_id: remoteMemberObject.local_leg_id,
                streamIndex: streamIndex,
                type: (params.video) ? 'video' : 'screenshare',
                member_id: remoteMemberObject.remote_member_id,
                connection_event: connection_event
              });
          this.log.warn('transports has terminated or failed for member ' + event.body.member_id, event);
          break;
        default:
          this.log.debug('The ice connection status changed for member ' + event.body.member_id, remoteMemberObject.pc.iceConnectionState);
          break;
      }
    };

    const do_gatherDone = () => {
      if (!remoteMemberObject.pc) return;

      const data = {
        from: this.parentConversation.me.id,
        body: {
          other_member_id: remoteMemberObject.remote_member_id,
          answer: remoteMemberObject.pc.localDescription.sdp,
          leg_id: remoteMemberObject.remote_leg_id
        }
      };

      if (params && params.label) {
        data.label = params.label;
      }

      this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/rtc/${remoteMemberObject.local_leg_id}/answer`,
        data
      }).then((response) => {
        this.log.debug('successfully set answer for member ' + remoteMemberObject.remote_member_id);
      }).catch((error) => {
        this.log.error('rtc:answer:failed: failed to set answer for member ' + remoteMemberObject.remote_member_id);
      });
    };

    let gatheringTimer = null;
    let rtc_sent = false;
    remoteMemberObject.pc.onicegatheringstatechange = () => {
      switch (remoteMemberObject.pc.iceGatheringState) {
        case 'new':
          this.log.debug('ice gathering new for member ' + event.body.member_id);
          break;
        case 'complete':
          window.clearTimeout(gatheringTimer);
          gatheringTimer = null;
          if (!rtc_sent) {
            do_gatherDone();
          }

          this.log.debug('ice gathering complete for member ' + event.body.member_id);
          break;
        case 'gathering':
          gatheringTimer = setTimeout(() => {
            do_gatherDone();
            rtc_sent = true;
          }, 2000);

          this.log.debug('ice gathering gathering for member ' + event.body.member_id);
          break;
      }
    };
    const rtcAnswerFunc = () => {
      remoteMemberObject.pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: event.body.sdp
      }))
          .then(() => {
            return remoteMemberObject.pc.createAnswer();
          })
          .then((answer) => {
            return remoteMemberObject.pc.setLocalDescription(answer);
          });
    };
    this._runWhenLegInitialized(remoteMemberObject.local_leg_id, rtcAnswerFunc);
  }

  _onConnectionFail(member, connection_details) {
    return this._disableLeg(connection_details.rtc_id)
        .catch((e) => {
          return new NexmoApiError(e);
        })
        .finally(() => {
          return member.emit('media:connection:fail', connection_details);
        });
  }

  _handleMemberLeft(member_left) {
    const member_id = member_left.id;
    const member_legs = this.parentConversation.remoteMembers.filter((member) => {
      return member.remote_member_id === member_id;
    });
    member_legs.forEach((member_leg) => {
      this._handleParticipantRtcTerminate({
        body: {
          rtc_id: member_leg.remote_leg_id
        }
      });
    });
  }

  _handleParticipantRtcTerminate(event) {
    const member = this.parentConversation.remoteMembers.find((member) => {
      return member.remote_leg_id === event.body.rtc_id;
    });

    if (!member) {
      this.log.error('rtc:terminate was sent with invalid member id');
      return;
    }

    this.parentConversation.remoteMembers = this.parentConversation.remoteMembers.filter((remoteMember) => {
      return remoteMember.remote_leg_id !== event.body.rtc_id;
    });
    this._deleteMemberMedia(member);
    member.remote_member.emit('media:stream:off', {
      remote_member_id: member.remote_member_id,
      streamIndex: member.streamIndex
    });
  }

  _deleteMemberMedia(member) {
    this._closeStream(member.stream);
    member.pc.close();
  }

  _findRtcObjectByType(type) {
    return Object.values(this.rtcObjects).find((rtcObject) => rtcObject.type === type);
  }

  update(params) {
    return new Promise((resolve, reject) => {
      this._validateUpdateParams(params)
          .then(() => {
            if (params.video) {
              const rtcObject = this._findRtcObjectByType('video');
              if ((rtcObject && params.video.direction) || (!rtcObject && !params.video.direction)) {
                return reject(new NexmoClientError('error:media:update:invalid'));
              }
            } else if (params.screenshare) {
              const rtcObject = this._findRtcObjectByType('screenshare');
              if ((rtcObject && params.screenshare.direction) || (!rtcObject && !params.screenshare.direction)) {
                return reject(new NexmoClientError('error:media:update:invalid'));
              }
            }
            return this._handleVideo(params).then(resolve).catch(reject);
          }).catch((err) => reject(err));
    });
  }

  _validateUpdateParams(params) {
    return new Promise((resolve, reject) => {
      if (params && (params.video || params.screenshare)) {
        if (params.video && params.screenshare) {
          return reject(new NexmoClientError('error:media:update:streams'));
        }
      } else {
        return reject(new NexmoClientError('error:media:update:unsupported'));
      }
      resolve();
    });
  }

  _closeStream(stream) {
    stream.getTracks().forEach((track) => {
      track.stop();
    });
  }

  _cleanConversationProperties() {
    return Promise.resolve().then(() => {
      if (this.pc) {
        this.pc.close();
      }
      if (this.parentConversation.remoteMembers) {
        this.parentConversation.remoteMembers.forEach((member) => {
          member.remote_member.emit('media:stream:off', {
            remote_member_id: member.remote_member_id,
            streamIndex: member.streamIndex
          });
          this._deleteMemberMedia(member);
        });
      }

      // stop active stream
      delete this.pc;
      this.rtcStats = null;
      this.application.activeStreams = [];
      this.parentConversation.remoteMembers = [];
      this.listeningToRtcEvent = false;
    });
  }

  /**
   * Cleans up the user's media before leaving the conversation
  */
  _cleanMediaProperties() {
    if (this.pc) {
      this.pc.close();
    }

    if (this.rtcObjects) {
      for (const leg_id in this.rtcObjects) {
        this._closeStream(this.rtcObjects[leg_id].stream);
      }
    }

    delete this.pc;
    this.rtcStats = null;
    this.application.activeStreams = [];
    this.rtcObjects = {};
    this.parentConversation.remoteMembers = [];
    this.listeningToRtcEvent = false;
  }

  _disableLeg(leg_id) {
    const csRequestPromise = new Promise((resolve, reject) => {
      this.application.session.sendNetworkRequest({
        type: 'DELETE',
        path: `conversations/${this.parentConversation.id}/rtc/${leg_id}?from=${this.parentConversation.me.id}&originating_session=${this.application.session.session_id}`,
        version: 'beta2'
      }).then((response) => {
        resolve('rtc:terminate:success');
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
    const closeResourcesPromise = Promise.resolve().then(() => {
      if (this.rtcObjects[leg_id].pc) {
        this.rtcObjects[leg_id].pc.close();
      }
      if (this.rtcObjects[leg_id].stream) {
        this._closeStream(this.rtcObjects[leg_id].stream);
      }
    });
    return Promise.all([csRequestPromise, closeResourcesPromise]).then(() => {
      this.parentConversation.me.emit('media:stream:off', this.rtcObjects[leg_id].streamIndex);
      delete this.rtcObjects[leg_id];
      return Promise.resolve('rtc:terminate:success');
    }).catch((error) => {
      return Promise.reject(error);
    });
  }

  _enableMediaTracks(tracks, enabled) {
    tracks.forEach((mediaTrack) => {
      mediaTrack.enabled = enabled;
    });
  }

  /**
   * Send a mute request with the rtc_id and enable/disable the tracks
   * If the mute request fails revert the changes in the tracks
   * @private
  */
  _setMediaTracksAndMute(rtc_id, tracks, mute, mediaType) {
    this._enableMediaTracks(tracks, !mute);
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/events`,
        data: {
          type: mediaType,
          to: this.parentConversation.me.id,
          from: this.parentConversation.me.id,
          body: {
            rtc_id
          }
        }
      }).then((response) => {
        resolve(response);
      }).catch((error) => {
        this._enableMediaTracks(tracks, mute);
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Replaces the stream's tracks currently being used as the sender's sources with a new one
   * @param {object} constraints - video and audio constraints
   * @param {string} type - rtc object type
   * @param {object} [constraints.audio] - set audio constraints - { deviceId: { exact: microphoneId } }
   * @param {object} [constraints.video] - set video constraints - { deviceId: { exact: cameraId } }
   * @returns {Promise<MediaStream>} - Returns the new stream.
   * @example <caption>Update the stream currently being used with a new one</caption>
  */
  updateSource(constraints, type = 'video') {
    if (!RTCRtpSender.prototype.replaceTrack) {
      return Promise.reject(new NexmoApiError('Not implemented yet'));
    }
    let rtcObjectByType = this._findRtcObjectByType(type);
    if (rtcObjectByType && rtcObjectByType.pc) {
      return this.rtcHelper.getUserVideo(constraints.video, constraints.audio).then((localStream) => {
        localStream.getTracks().forEach((track) => {
          const sender = rtcObjectByType.pc.getSenders().find((s) => s.track.kind === track.kind);
          if (sender) {
            track.enabled = sender.track.enabled;
            sender.replaceTrack(track);
          }
        });
        this._closeStream(rtcObjectByType.stream);
        rtcObjectByType.stream = localStream;
        return localStream;
      });
    } else {
      return Promise.reject(new NexmoApiError('error:media:stream:not-found'));
    }
  }

  /**
   * Replaces the stream's audio tracks currently being used as the sender's sources with a new one
   * @param {object} constraints - audio constraints
   * @param {string} type - rtc object type
   * @param {object} [constraints.audio] - set audio constraints - { deviceId: { exact: microphoneId } }
   * @returns {Promise<MediaStream>} - Returns the new stream.
   * @example <caption>Update the stream currently being used with a new one</caption>
  */
  updateAudioConstraints(constraints = {}) {
    let rtcObjectByType = this._findRtcObjectByType('audio');
    if (rtcObjectByType && rtcObjectByType.pc) {
      return this.rtcHelper.getUserAudio(constraints).then((localStream) => {
        localStream.getTracks().forEach((track) => {
          const sender = rtcObjectByType.pc.getSenders().find((s) => s.track.kind === track.kind);
          if (sender) {
            track.enabled = sender.track.enabled;
            sender.replaceTrack(track);
          }
        });
        this._closeStream(rtcObjectByType.stream);
        rtcObjectByType.stream = localStream;
        return localStream;
      }).catch((error) => {
        return error;
      });
    } else {
      return Promise.reject(new NexmoApiError('error:media:stream:not-found'));
    }
  }

  /**
   * Mute our member
   *
   * @param {boolean} [mute=false] true for mute, false for unmute
   * @param {boolean} [audio=true] true for audio stream - relevant only in video conversation
   * @param {boolean} [video=false] true for video stream - relevant only in video conversation
   * @param {number} [streamIndex] stream id to set - if it's not set all streams will be muted
   * @example <caption>Mute audio stream in non video conversation</caption>
   * media.mute(true)
   * @example <caption>Mute audio and video streams in video conversation</caption>
   * media.mute(true, true, true, 0)
   * @example <caption>Mute only video in video conversation</caption>
   * media.mute(true, false, true, 0)
  */
  mute(mute = false, audio = true, video = false, streamIndex = null) {
    const state = mute ? 'on' : 'off';
    const audioType = 'audio:mute:' + state;
    const videoType = 'video:mute:' + state;
    let promises = [];
    let muteObjects = {};

    if (streamIndex !== null) {
      muteObjects[0] = Object.values(this.rtcObjects).find(((rtcObj) => rtcObj.streamIndex === streamIndex));
      if (!muteObjects[0]) {
        throw new NexmoClientError('error:media:stream:not-found');
      }
    } else {
      muteObjects = this.rtcObjects;
    }
    Object.values(muteObjects).forEach((rtcObject) => {
      if (audio) {
        const audioTracks = rtcObject.stream.getAudioTracks();
        const audioPromise = this._setMediaTracksAndMute(rtcObject.rtc_id, audioTracks, mute, audioType);
        promises.push(audioPromise);
      }

      if (video) {
        const videoTracks = rtcObject.stream.getVideoTracks();
        const videoPromise = this._setMediaTracksAndMute(rtcObject.rtc_id, videoTracks, mute, videoType);
        promises.push(videoPromise);
      }
    });

    return Promise.all(promises);
  }

  /**
   * Earmuff our member
   *
   * @param {boolean} [params]
   *
   * @returns {Promise}
   * @private
  */
  earmuff(earmuff) {
    return new Promise((resolve, reject) => {
      if (this.me === null) {
        reject(new NexmoClientError('error:self'));
      } else {
        let type = 'audio:earmuff:off';
        if (earmuff) {
          type = 'audio:earmuff:on';
        }

        return this.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.parentConversation.id}/events`,
          data: {
            type,
            to: this.parentConversation.me.id
          }
        }).then(({response}) => {
          resolve(response);
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }

  /**
    * Enable media participation in the conversation for this application (requires WebRTC)
    * @param {object} params - rtc params
    * @param {string} params.label - Label is an application defined tag, eg. ‘fullscreen’
    * @param {object} [params.audio=true] - audio enablement mode. possible values "both", "send_only", "receive_only", "none", true or false
    * @param {object} [params.autoPlayAudio=false] - attach the audio stream automatically to start playing after enable media (default false)
    * * <!-- the following line should be added when deploying video to prod.
    * @param {object} [params.video=false] - video enablement mode. possible values "both", "send_only", "receive_only", "none", true or false
    * @param {object} [params.video={direction: 'some_direction', constraints: constraints_object}] - video enablement mode.
    * possible values for direction "both", "send_only", "receive_only", "none", true or false
    * @param {object} [params.screenshare=false] -screen sharing enablement mode. possible values "send_only", "none", true or false
    * @param {object} [params.screenshare={direction: 'some_direction'}] - screen sharing enablement mode. possible values for direction "send_only", "none", true or false  -->
    * @returns {Promise<MediaStream>}
    * @example <caption>Enable media in this conversation</caption>
    * function enable() {
    *   conversation.media.enable()
    *      .then((stream) => {
              const media = document.createElement("audio");
              const source = document.createElement("source");
              const media_div = document.createElement("div");
              media.appendChild(source);
              media_div.appendChild(media);
              document.insertBefore(media_div);
              // Older browsers may not have srcObject
              if ("srcObject" in media) {
                media.srcObject = stream;
              } else {
                // Avoid using this in new browsers, as it is going away.
                media.src = window.URL.createObjectURL(stream);
              }
              media.onloadedmetadata = (e) => {
                media.play();
              };
    *
    * 		 }).catch((error) => {
    *           console.log(error);
    *       });
    * }
    *
    *
    *
  **/
  enable(params) {
    return new Promise((resolve, reject) => {
      if (this.parentConversation.me === null) {
        reject(new NexmoClientError('error:self'));
      } else {
        if (params && this.parentConversation.is_video_conversation) {
          return this._handleVideo(params)
              .then((localStream) => {
                const types = ['video', 'screenshare'];
                let disablePromises = [];
                types.forEach((type) => {
                  if (!params[type]) {
                    let rtcObjectWithType = this._findRtcObjectByType(type);
                    if (rtcObjectWithType) {
                      disablePromises.push(this._disableLeg(rtcObjectWithType.rtc_id));
                    }
                  }
                });
                Promise.all(disablePromises)
                    .then(() => {
                      resolve(localStream);
                    });
              })
              .catch((e) => {
                reject(e);
              });
        }
        // this needs to happen soon before we use pc.trace
        // ps.trace is injected in rtcstats module
        if (this.rtcstats_conf.emit_events) {
          this._initStatsEvents();
        }

        this._handleAudio(params)
            .then((stream) => {
            // attach the audio stream automatically to start playing
              let autoPlayAudio = (params && (params.autoPlayAudio || params.autoPlayAudio === undefined)) ? true : false;
              if (!params || autoPlayAudio) {
                this.rtcHelper._playAudioStream(stream);
              }

              resolve(stream);
            })
            .catch((err) => {
              reject(err);
            });
      }
    });
  }

  /**
   * Disable media participation in the conversation for this application
   * if RtcStats MOS is enabled, a final report will be available in
   * NexmoClient#rtcstats:report
   * @returns {Promise}
   * @example
   *
   * function disable() {
   *   conversation.media.disable()
   *      .then((response) => {
   *       }).catch((error) => {
   *           console.log(error);
   *       });
   * }
   *
  **/
  disable() {
    let promises = [];
    promises.push(this._cleanConversationProperties());

    for (const leg_id in this.rtcObjects) {
      promises.push(this._disableLeg(leg_id));
    }
    return Promise.all(promises);
  }

  /**
   * Play a voice text in a conversation
   * @param {object} params
   * @param {string} params.text - the text to say in the conversation
   * @param {string} params.voice_name -
   * @param {number} params.level - [0] -
   * @param {boolean} params.queue -
   * @param {boolean} params.loop -
   *
   * @returns {Promise<NXMEvent>}
   * @example
   *   conversation.media.sayText({text:'hi'})
  **/
  sayText(params) {
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/events`,
        data: {
          type: 'audio:say',
          cid: this.parentConversation.id,
          from: this.parentConversation.me.id,
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
    * Send DTMF in a conversation
    * @param {string} digit - the DTMF digit(s) to send
    *
    * @returns {Promise<NXMEvent>}
    * @example
    * conversation.media.sendDTMF('digit')
  **/
  sendDTMF(digit) {
    return new Promise((resolve, reject) => {
      if (!Utils.validateDTMF(digit)) {
        reject(new NexmoClientError('error:audio:dtmf:invalid-digit'));
      } else {
        return this.application.session.sendNetworkRequest({
          type: 'POST',
          path: `conversations/${this.parentConversation.id}/events`,
          data: {
            type: 'audio:dtmf',
            from: this.parentConversation.me.id,
            body: {
              digit
            }
          }
        }).then((response) => {
          const placeholder_event = {
            body: {
              digit,
              dtmf_id: ''
            },
            cid: this.parentConversation.id,
            from: this.parentConversation.me.id,
            id: response.id,
            timestamp: response.timestamp,
            type: 'audio:dtmf'
          };
          const dtmfEvent = new NXMEvent(this.parentConversation, placeholder_event);
          this.parentConversation.events.set(placeholder_event.id, dtmfEvent);
          resolve(dtmfEvent);
        }).catch((error) => {
          reject(new NexmoApiError(error));
        });
      }
    });
  }

  /**
   * Play an audio stream in a conversation
   * @returns {Promise<NXMEvent>}
  */
  playStream(params) {
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/events`,
        data: {
          type: 'audio:play',
          body: params
        }
      }).then((response) => {
        resolve(new NXMEvent(this.parentConversation, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Send start ringing event
   * @returns {Promise<NXMEvent>}
   * @example
   * Send ringing event
   * function startRinging() {
   *   conversation.media.startRinging()
   *      .then((response) => {
   *       }).catch((error) => {
   *           console.log(error);
   *       });
   * }
   *
   * conversation.on('audio:ringing:start', (data) => {
   * console.log("ringing");
   * });
  */
  startRinging() {
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/events`,
        data: {
          type: 'audio:ringing:start',
          from: this.parentConversation.me.id,
          body: {}
        }
      }).then((response) => {
        resolve(new NXMEvent(this.parentConversation, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }

  /**
   * Send stop ringing event
   * @returns {Promise<NXMEvent>}
   * @example
   * Send ringing event
   * function stopRinging() {
   *   conversation.media.stopRinging()
   *      .then((response) => {
   *       }).catch((error) => {
   *           console.log(error);
   *       });
   * }
   *
   * conversation.on('audio:ringing:stop', (data) => {
   *  console.log("ringing stopped");
   * }
  */
  stopRinging() {
    return new Promise((resolve, reject) => {
      return this.application.session.sendNetworkRequest({
        type: 'POST',
        path: `conversations/${this.parentConversation.id}/events`,
        data: {
          type: 'audio:ringing:stop',
          from: this.parentConversation.me.id,
          body: {}
        }
      }).then((response) => {
        resolve(new NXMEvent(this.parentConversation, response));
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }
}

module.exports = Media;

},{"../events/nxmEvent":4,"../nexmoClientError":20,"../utils":28,"./rtc_helper":16,"./rtcstats/rtcstats":18,"./rtcstats/trace-ws":19,"loglevel":52}],15:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  NXMCall Object Model
 *
 * Copyright (c) Nexmo Inc.
*/

const WildEmitter = require('wildemitter');
const NexmoClientError = require('../nexmoClientError').NexmoClientError;
const NexmoApiError = require('../nexmoClientError').NexmoApiError;
const getLogger = require('loglevel').getLogger;

/**
 * Conversation NXMCall Object.
 * @class NXMCall
 * @param {Application} application - The Application object.
 * @param {Conversation} conversation - The Conversation object that belongs to this nxmCall.
 * @param {Member} from - The member that initiated the nxmCall.
 * @property {Application} application -  The Application object that the nxmCall belongs to.
 * @property {Conversation} conversation -  The Conversation object that belongs to this nxmCall.
 * @property {Member} from - The caller. The member object of the caller (not a reference to the one in conversation.members)
 * @property {Map<string, Member>} to - The callees keyed by a member's id. The members that receive the nxmCall (not a reference to conversation.members)
 * @property {String} id - The nxmCall id (our member's leg_id, comes from rtc:answer event, or member:media)
 * @property {NXMCall.CALL_STATUS} CALL_STATUS="started" - the available nxmCall statuses
 * @property {NXMCall.CALL_DIRECTION} direction - the Direction of the nxmCall, Outbound, Inbound
 * @property {NXMCall.STATUS_PERMITTED_FLOW} STATUS_PERMITTED_FLOW - the permitted nxmCall status transition map, describes the "from" and allowed "to" transitions
 * @emits Application#member:call
 * @emits Application#call:status:changed
*/

/**
 * Application listening for calls.
 *
 * @event Application#member:call
 *
 * @property {Member} member - the member that initiated the nxmCall
 * @property {NXMCall} nxmCall -  resolves the nxmCall object
 *
 * @example <caption>listen for calls in Application level</caption>
 *  application.on("member:call", (member, nxmCall) => {
 *              console.log("NXMCall ", nxmCall);
 *              });
 *      });
*/

/**
 * NXMCall listening for nxmCall status changed events.
 *
 * @event Application#call:status:changed
 * @property {NXMCall} nxmCall -  the actual event
 * @example <caption>listen for nxmCall status events</caption>
 *  application.on("call:status:changed",(nxmCall) => {
 *              console.log("call: " + nxmCall.status);
 *       });
 *   });
*/
class NXMCall {
  constructor(application, conversation, from) {
    this.application = application;
    this.log = getLogger(this.constructor.name);
    this.from = from;
    this.conversation = null;

		/**
		 * Enum for NXMCall status.
		 * @readonly
		 * @enum {string}
		 * @alias NXMCall.CALL_STATUS
		*/
    this.CALL_STATUS = {
      /** The NXMCall is in started status */
      STARTED: 'started',
      /** The NXMCall is in ringing status */
      RINGING: 'ringing',
      /** The NXMCall is in answered status */
      ANSWERED: 'answered',
      /** The NXMCall is in completed status */
      COMPLETED: 'completed',
      /** The NXMCall is in busy status */
      BUSY: 'busy',
      /** The NXMCall is in timeout status */
      TIMEOUT: 'timeout',
      /** The NXMCall is in unanswered status */
      UNANSWERED: 'unanswered',
      /** The NXMCall is in rejected status */
      REJECTED: 'rejected',
      /** The NXMCall is in failed status */
      FAILED: 'failed'
    };

		/**
		 * Enum for NXMCall direction.
		 * @readonly
		 * @enum {string}
		 * @alias NXMCall.CALL_DIRECTION
		*/
    this.CALL_DIRECTION = {
      /** The NXMCall started from another end */
      INBOUND: 'inbound',
      /** The NXMCall started from this client */
      OUTBOUND: 'outbound'
    };
    Object.freeze(this.CALL_DIRECTION);

		/**
		 * Enum for the permitted call status transition.
		 * @readonly
		 * @alias NXMCall.STATUS_PERMITTED_FLOW
		 * @enum {Map<string, Set<NXMCall.CALL_STATUS>>}
		*/
    this.STATUS_PERMITTED_FLOW = new Map([
      /** Permitted transition array from STARTED  */
      ['STARTED', new Set([
        this.CALL_STATUS.RINGING,
        this.CALL_STATUS.ANSWERED,
        this.CALL_STATUS.FAILED,
        this.CALL_STATUS.TIMEOUT,
        this.CALL_STATUS.UNANSWERED,
        this.CALL_STATUS.REJECTED,
        this.CALL_STATUS.BUSY
      ])],
      /** Permitted transition array from RINGING  */
      ['RINGING', new Set([
        this.CALL_STATUS.ANSWERED,
        this.CALL_STATUS.FAILED,
        this.CALL_STATUS.TIMEOUT,
        this.CALL_STATUS.UNANSWERED,
        this.CALL_STATUS.REJECTED,
        this.CALL_STATUS.BUSY
      ])],
      /** Permitted transition set from ANSWERED  */
      ['ANSWERED', new Set([
        this.CALL_STATUS.COMPLETED,
        this.CALL_STATUS.FAILED
      ])]
    ]);
    Object.freeze(this.STATUS_PERMITTED_FLOW);

    this.status = null;
    this.direction = this.CALL_DIRECTION.INBOUND;
    this._setupConversationObject(conversation);
    WildEmitter.mixin(NXMCall);
  }
	/**
	 * Enable NXMCall stats to be emitted in application.inAppCall.on('call:stats:report');
	 * @private
	*/
  _enableStatsEvents() {
    if (this.application.session.config && this.application.session.config.rtcstats && !this.application.session.config.rtcstats.emit_events) {
      return this.conversation.media._enableStatsEvents();
    }
  }

	/**
	 * Attach member event listeners from the conversation
	 * @private
	*/
  _attachCallListeners() {
    // Conversation level listeners
    this.conversation.releaseGroup('call_module');
    this.conversation.on('member:media', 'call_module', (from, event) => {
      if (this.application.calls && this.application.calls.has(this.conversation.id)) {
        this.application.calls.get(this.conversation.id)._handleStatusChange(event);
      }
    });
  }

	/**
	 * Validate the current nxmCall status transition
	 * If a transition is not defined, return false
	 * @param {string} status the status to validate
	 * @returns {boolean} false if the transition is not permitted
	 * @private
	*/
  _isValidStatusTransition(status) {
    if (!status) {
      throw new NexmoClientError(`Provide the status to validate the transition from '${this.status}'`);
    }
    // if the nxmCall object is just initialised allow any state
    if (!this.status) {
      return true;
    }
    const current_status = this.status.toUpperCase();
    if (!this.STATUS_PERMITTED_FLOW.has(current_status)) {
      return false;
    }
    if (this.status === status) {
      return false;
    }

    return (this.STATUS_PERMITTED_FLOW.get(current_status).has(status));
  }

	/**
	 * Go through the members of the conversation and if .me is the only one (JOINED or INVITED)
	 * nxmCall nxmCall.hangUp().
	 * @returns {Promise} - empty promise or the nxmCall.hangUp promise chain
	*/
  hangUpIfAllLeft() {
    if (!this.conversation.me || this.conversation.me.state === 'LEFT' || this.conversation.members.size <= 1) {
      return Promise.resolve();
    }
    for (let member of this.conversation.members.values()) {
      if (member.state !== 'LEFT' && (this.conversation.me.user.id !== member.user.id)) {
        return Promise.resolve();
      }
    }
    return this.hangUp();
  }

	/**
	 * Set the conversation object of the NXMCall
	 * update nxmCall.from, and nxmCall.to attributes based on the conversation members
	 * @private
	*/
  _setupConversationObject(conversation) {
    if (!conversation) return;
    this.conversation = conversation;
    if (!conversation.me) {
      this.log.debug('missing own member object');
    } else {
      this.to = new Map(conversation.members);
      if (this.from) {
        this.to.delete(this.from.id);
      }
    }
    this._attachCallListeners();
  }

	/**
	 * Set the from object of the NXMCall
	 * @private
	*/
  _setFrom(from) {
    this.from = from;
  }

	/**
	 * Process raw events to figure out the nxmCall status
	 * @private
	*/
  _handleStatusChange(event) {
    // for knocking case the conversation object is not yet set in the nxmCall. We know the action is initiated from us
    const _isEventFromMe = (this.conversation) ? this.conversation.me.id === event.from : true;
    const _isOutbound = this.direction === this.CALL_DIRECTION.OUTBOUND;

    const _handleStatusChangeMap = {
      'member:joined': () => {
        if (event.body.channel && event.body.channel.knocking_id) {
          return this.conversation.media.enable()
              .then((stream) => {
                this._setStatusAndEmit(this.CALL_STATUS.STARTED);
                return Promise.resolve();
              }).catch((error) => {
                this._setStatusAndEmit(this.CALL_STATUS.FAILED);
                this.log.error(error);
                return Promise.reject(error);
              });
        }
        return Promise.resolve();
      },
      'member:invited': () => {
        if (event.body.invited_by === null
          && event.body.user.media
          && event.body.user.media.audio_settings) {
          this._setStatusAndEmit(this.CALL_STATUS.STARTED);
        }
        return Promise.resolve();
      },
      'member:left': () => {
        if (this.status === this.CALL_STATUS.ANSWERED) {
          this._setStatusAndEmit(this.CALL_STATUS.COMPLETED);
          return Promise.resolve();
        } else {
          if (_isEventFromMe && _isOutbound || !_isEventFromMe && !_isOutbound) {
            this._setStatusAndEmit(this.CALL_STATUS.UNANSWERED);
            return Promise.resolve();
          } else {
            this._setStatusAndEmit(this.CALL_STATUS.REJECTED);
            return Promise.resolve();
          }
        }
      },
      'member:media': () => {
        if (this.status !== this.CALL_STATUS.ANSWERED && event.body.audio) {
          if (!_isEventFromMe || !_isOutbound) {
            this._setStatusAndEmit(this.CALL_STATUS.ANSWERED);
          }
          if (_isEventFromMe && event.body.channel) {
            this.id = event.body.channel.id;
          }
        }
        return Promise.resolve();
      },
      'sip:ringing': () => {
        if (this.status !== this.CALL_STATUS.RINGING) {
          this._setStatusAndEmit(this.CALL_STATUS.RINGING);
        }
        return Promise.resolve();
      },
      'sip:hangup': () => {
        switch (event.body.reason.sip_code) {
          case 486:
            this._setStatusAndEmit(this.CALL_STATUS.BUSY);
            break;
          case 487:
            this._setStatusAndEmit(this.CALL_STATUS.TIMEOUT);
            break;
          case 403:
            this._setStatusAndEmit(this.CALL_STATUS.FAILED);
            break;
        }
        return Promise.resolve();
      },
      'knocking:delete:success': () => {
        this._setStatusAndEmit(this.CALL_STATUS.UNANSWERED);
        return Promise.resolve();
      }
    };
    if (_handleStatusChangeMap.hasOwnProperty(event.type)) {
      return _handleStatusChangeMap[event.type].call(this);
    }
  }

	/**
	 * Set the nxmCall.status and emit a call:status:changed event
	 *
	 * @param {NXMCall.CALL_STATUS} this.CALL_STATUS the canxmCallll status to set
	 * @emits Application#call:status:changed
	 * @private
	*/
  _setStatusAndEmit(status) {
    if (!this._isValidStatusTransition(status)) {
      this.log.warn(`status attempt switch from ${this.status} to ${status}`);
      return;
    }
    this.status = status;
    this.application.emit('call:status:changed', this);
  }

	/**
	 * Answers an incoming nxmCall
	 * Join the conversation that you are invited
	 * Create autoplay Audio object
	 *
   * @param {boolean} [autoPlayAudio=true] attach the audio stream automatically to start playing (default true)
	 * @returns {Promise<Audio>}
	*/
  answer(autoPlayAudio = true) {
    if (this.conversation) {
      return this.conversation.join()
          .then(() => {
            return this.conversation.media.enable({
              autoPlayAudio
            });
          })
          .catch((error) => {
            this._setStatusAndEmit(this.CALL_STATUS.FAILED);
            this.log.error(error);
            return Promise.reject(error);
          });
    } else {
      return Promise.reject(new NexmoClientError('error:call:answer'));
    }
  }

	/**
	 * Trigger the nxmCall flow for the input users.
	 * Create a conversation with prefix name "CALL_"
	 * and invite all the users.
	 * If at least one user is successfully invited, enable the audio.
	 *
	 * @param {string[]} usernames the usernames of the users to call
   * @param {boolean} [autoPlayAudio=true] attach the audio stream automatically to start playing (default true)
	 * @returns {Promise[]} an array of the invite promises for the provided usernames
	 * @private
	*/
  createCall(usernames, autoPlayAudio = true) {
    if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
      return Promise.reject(new NexmoClientError('error:application:call:params'));
    }

    return this.application.newConversationAndJoin(
        {display_name: 'CALL_' + this.application.me.name + '_' + usernames.join('_').replace(' ', '')})
        .then((conversation) => {
          this.from = conversation.me;
          this.successful_invited_members = new Map();
          const invites = usernames.map((username) => {
            // check all invites, if at least one is resolved enable audio
            // we need to catch rejections to allow all the chain to go through (all invites)
            // we then catch-reject a promise so that the errors are passing through the end of the chain
            return conversation.inviteWithAudio({user_name: username})
                .then((member) => {
                  this.successful_invited_members.set(member.id, member);
                  return Promise.resolve(member);
                })
                .catch((error) => {
                  this.log.warn(error);
                  // resolve the error to allow the promise.all to collect
                  // and return all the promises
                  return Promise.resolve(error);
                });
          });
          // helper function to process in Promise.all() the failed invites too
          const process_invites = () => {
            if (this.successful_invited_members.size > 0) {
              return conversation.media.enable({
                audio: {
                  muted: false,
                  earmuffed: false
                },
                autoPlayAudio
              }).then((stream) => {
                this.application.calls.set(conversation.id, this);
                return Promise.resolve(invites);
              });
            } else {
              return Promise.reject(invites);
            }
          };
          // we need to continue the invites even if one fails,
          // in process_invites we do the check if at least one was successful
          return Promise.all(invites).then(() => {
            this._setupConversationObject(conversation);
            return process_invites();
          });
        }).catch((error) => {
          this.log.warn(error);
          this._setStatusAndEmit(this.CALL_STATUS.FAILED);
          return Promise.reject(error);
        });
  }

	/**
	 * Trigger the nxmCall flow for the phone call.
	 * Create a knocking event
	 *
	 * @param {string} user the phone number or the username to call
   * @param {string} type the type of the call you want to have. possible values "phone" or "app" (default is "phone")
	 * @returns {Promise}
	 * @private
	*/
  createServerCall(user, type) {
    const to = {
      type
    };
    if (type === 'phone') {
      to.number = user;
    } else {
      to.user = user;
    }
    return new Promise((resolve, reject) => {
      this.application.session.sendNetworkRequest({
        type: 'POST',
        path: 'knocking',
        data: {
          channel: {
            type: 'app',
            from: {
              type: 'app'
            },
            to
          }
        }
      }).then((response) => {
        resolve(response);
      }).catch((error) => {
        reject(new NexmoApiError(error));
      });
    });
  }
	/**
	 * Hangs up the nxmCall
	 *
	 * If there is a knocking active, do a knocking:delete
	 * otherwise
	 * Leave from the conversation
	 * Disable the audio
	 *
   * @param {object} [reason] the reason for hanging up the nxmCall
   * @param {string} [reason.reason_code] the code of the reason
   * @param {string} [reason.reason_text] the description of the reason
	 * @returns {Promise}
	*/
  hangUp(reason) {
    let disable_promise = [];
    if (this.conversation) {
      disable_promise.push(this.conversation.media.disable());
    }
    return Promise.all(disable_promise).finally(() => {
      if (!this.knocking_id) {
        return this.conversation.leave(reason);
      } else {
        return new Promise((resolve, reject) => {
          let path = `knocking/${this.knocking_id}`;
          if (reason) {
            let params = new URLSearchParams();
            Object.keys(reason).forEach((key) => {
              params.append(key, reason[key]);
            });
            path += `?${params.toString()}`;
          }

          this.application.session.sendNetworkRequest({
            type: 'DELETE',
            path
          }).then((response) => {
            const nxmCall = this.application._call_draft_list.get(this.knocking_id);
            nxmCall._handleStatusChange(response);
            this.application._call_draft_list.delete(this.knocking_id);
            resolve(response);
          }).catch((error) => {
            // Don't switch yet to fail status, it could be an expected race between knocking:delete and conversation.leave
            if (!this.conversation) {
              this.log.warn('Problem cancelling the call: Knocking cancel failed and Conversation.leave not available');
              resolve();
            } else {
              this.conversation.leave(reason).then(resolve).catch(reject);
              this.log.warn(new NexmoApiError(error));
            }
          });
        });
      }
    });
  }

	/**
	 * Rejects an incoming nxmCall
	 * Leave from the conversation that you are invited
	 *
   * @param {object} [reason] the reason for rejecting the nxmCall
   * @param {string} [reason.reason_code] the code of the reason
   * @param {string} [reason.reason_text] the description of the reason
	 * @returns {Promise}
	*/
  reject(reason) {
    if (this.conversation) {
      return this.conversation.leave(reason);
    } else {
      return Promise.reject(new NexmoClientError('error:call:reject'));
    }
  }
}

module.exports = NXMCall;

},{"../nexmoClientError":20,"loglevel":52,"wildemitter":100}],16:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
 */

require('webrtc-adapter');
const browserDetect = require('detect-browser');
const getLogger = require('loglevel').getLogger;
const ChromeHelper = require('./chrome_helper');
const NexmoClientError = require('../nexmoClientError').NexmoClientError;

/**
 * RTC helper object for accessing webRTC API.
 * @class RtcHelper
 * @private
*/
class RtcHelper {
  constructor() {
    this.log = getLogger(this.constructor.name);
  }

  getUserAudio(audioConstraints = true) {
    let constraintsToUse = {
      video: false,
      audio: audioConstraints
    };
    return navigator.mediaDevices.getUserMedia(constraintsToUse);
  }

  getUserVideo(videoConstraints = true, audioConstraints = true) {
    let constraintsToUse = {
      video: videoConstraints,
      audio: audioConstraints
    };
    return navigator.mediaDevices.getUserMedia(constraintsToUse);
  }

  /**
   * Gets the user's screen stream that is to be shared.
   * @param {Object} options
   * @param {Array} options.sources - Array specifying the sources. Possible values in sources
   * are 'screen', 'window' and 'tab'.
   * @param {string} options.sourceId - Specifies source Id of the stream that should be shared.
  */
  getUserScreen(options) {
    return Promise.resolve().then(() => {
      if (options && options.sourceId) {
        return Promise.resolve();
      }
      return this.checkChromeExtensionIsInstalled();
    }).then(() => {
      return this.getShareScreenStream(options);
    });
  }

  createRTCPeerConnection(config, constraints, clientId) {
    constraints.optional.push({clientId: clientId});
    const pc = new RTCPeerConnection(config, constraints);
    // attaching the .trace to make easier the stats reporting implementation
    pc.trace = () => {
      return;
    };
    return pc;
  }

  checkChromeExtensionIsInstalled() {
    if (this._getBrowserName() === 'chrome') {
      if (!this.chromeHelper) {
        this._initChromeHelper();
      }
      return this.chromeHelper.checkScreenShareInstalled();
    } else {
      // Firefox or others, no need for the extension (but this doesn't mean it will work)
      return Promise.resolve();
    }
  }

  getShareScreenStream(options) {
    switch (this._getBrowserName()) {
      case 'chrome':
        return this.chromeGetShareScreenStream(options);
      case 'firefox':
        return this.fireFoxGetShareScreenStream();
      default:
        return Promise.reject(new NexmoClientError('error:media:unsupported-browser'));
    }
  }

  fireFoxGetShareScreenStream() {
    let constraints = {
      video: {
        mozMediaSource: 'screen',
        mediaSource: 'screen'
      },
      audio: false
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  /**
   * Get the ScreenShare stream
   * video settings:
   * chromeMediaSource: 'desktop',
   * maxWidth: window.screen.width,
   * maxHeight: window.screen.height,
   * maxFrameRate: 15
   * @param {Object} options
   * @param {Array} options.sources - Array specifying the sources. Possible values in sources
   * are 'screen', 'window' and 'tab'.
   * @param {string} options.sourceId - Specifies source Id of the stream that should be shared.
   * @private
  */
  chromeGetShareScreenStream(options) {
    if (!this.chromeHelper) {
      this._initChromeHelper();
    }
    if (options && options.sourceId) {
      return this._getScreenShareStream(options.sourceId);
    }
    const sources = options ? options.sources : undefined;
    return this.chromeHelper.getScreenShare(sources)
        .then((sourceId) => this._getScreenShareStream(sourceId));
  }

  _getScreenShareStream(sourceId) {
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          maxWidth: window.screen.width,
          maxHeight: window.screen.height,
          maxFrameRate: 15,
          chromeMediaSourceId: sourceId
        },
        optional: []
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  _playAudioStream(stream) {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    return audio;
  }

  _getWindowLocationProtocol() {
    return window.location.protocol;
  }

  _getBrowserName() {
    return browserDetect.detect().name;
  }

  /**
   * sets this.screenShareExtensionId for cases we need Screen Share support for Chrome
   * @param {string} screenShareExtensionId the screen share extension id to set
   * @returns {Promise}
   * @private
  */
  _setScreenShareExtensionId(screenShareExtensionId) {
    if (typeof screenShareExtensionId !== 'string') {
      return Promise.reject(new NexmoClientError('not a valid extension id string'));
    }
    this.screenShareExtensionId = screenShareExtensionId;
    return Promise.resolve();
  }

  /**
   * sets this.chromeHelper object to enable screenshare capabilities
   * @returns {Promise<ChromeHelper>} the generated instance of ChromeHelper
   * @private
  */
  _initChromeHelper() {
    if (!this.screenShareExtensionId) {
      return Promise.reject(new NexmoClientError('screenShareExtensionId not set, set it with _setScreenShareExtensionId(screenShareExtensionId)'));
    }
    this.chromeHelper = new ChromeHelper(this.screenShareExtensionId);
    return Promise.resolve(this.chromeHelper);
  }

  isNode() {
    return this._getBrowserName() === 'node';
  }

  /**
   * Check whether the offer SDP has both video and audio enabled and
   * compare the order of them to match with the answer SDP order
   *
   * @param {string} offer the offer SDP
   * @param {string} answer the answer SDP
   * @returns {string} the new edited answer SDP
   * @private
  */
  editSDPOrder(offer, answer) {
    const offerGroupBundleProto = 'a=group:bundle';
    const offerGroupBundle = offer.toLowerCase().substring(offer.toLowerCase().indexOf(offerGroupBundleProto)).split('\n')[0];

    if (offerGroupBundle !== '') {
      if ((offerGroupBundle.includes('0') && offerGroupBundle.includes('1'))
        || (offerGroupBundle.includes('audio') && offerGroupBundle.includes('video'))) {
        const answerAudioIndex = answer.indexOf('m=audio');
        const answerVideoIndex = answer.indexOf('m=video');
        offerGroupBundle.replace('audio', '0');
        offerGroupBundle.replace('video', '1');
        const offerOrder = offerGroupBundle.replace(offerGroupBundleProto, '').replace(/\s/g, '');

        if (Number(offerOrder[0]) < Number(offerOrder[1]) && answerAudioIndex > answerVideoIndex) {
          return answer.substring(0, answerVideoIndex)
              .concat(answer.substring(answerAudioIndex, answer.length),
                  answer.substring(answerVideoIndex, answerAudioIndex));
        } else if (Number(offerOrder[0]) > Number(offerOrder[1]) && answerAudioIndex < answerVideoIndex) {
          return answer.substring(0, answerAudioIndex)
              .concat(answer.substring(answerVideoIndex, answer.length),
                  answer.substring(answerAudioIndex, answerVideoIndex));
        }
      }
    }

    return answer;
  }

  /**
    * Check if the keys in an object are found in another object
  */
  checkValidKeys(object, defaultObject) {
    let valid = true;
    Object.keys(object).forEach((key) => {
      if (!defaultObject.hasOwnProperty(key)) {
        valid = false;
      };
    });
    return valid;
  };
}

module.exports = RtcHelper;

},{"../nexmoClientError":20,"./chrome_helper":12,"detect-browser":42,"loglevel":52,"webrtc-adapter":85}],17:[function(require,module,exports){
/* eslint-disable prefer-rest-params */
(function() {
  function r(e, n, t) {
    function o(i, f) {
      if (!n[i]) {
        if (!e[i]) {
          let c = 'function' === typeof require && require; if (!f && c) return c(i, !0); if (u) return u(i, !0); let a = new Error('Cannot find module \'' + i + '\''); throw a.code = 'MODULE_NOT_FOUND', a;
        } let p = n[i] = {exports: {}}; e[i][0].call(p.exports, function(r) {
          let n = e[i][1][r]; return o(n || r);
        }, p, p.exports, r, e, n, t);
      } return n[i].exports;
    // eslint-disable-next-line no-var
    } for (var u = 'function' === typeof require && require, i = 0; i < t.length; i++)o(t[i]); return o;
  } return r;
}())({
  1: [function(require, module, exports) {

  }, {'./rtcstats': 2, './trace-ws': 3}], 2: [function(require, module, exports) {
    'use strict';

    // transforms a maplike to an object. Mostly for getStats
    function map2obj(m) {
      if (!m.entries) {
        return m;
      }
      let o = {};
      m.forEach((v, k) => {
        o[k] = v;
      });
      return o;
    }

    // apply a delta compression to the stats report. Reduces size by ~90%.
    // To reduce further, report keys could be compressed.
    function deltaCompression(oldStats, newStats) {
      newStats = JSON.parse(JSON.stringify(newStats));
      Object.keys(newStats).forEach((id) => {
        if (!oldStats[id]) {
          return;
        }
        let report = newStats[id];
        Object.keys(report).forEach((name) => {
          if (report[name] === oldStats[id][name]) {
            delete newStats[id][name];
          }
          delete report.timestamp;
          if (Object.keys(report).length === 0) {
            delete newStats[id];
          }
        });
      });
      newStats.timestamp = new Date();
      return newStats;
    }

    function mangleChromeStats(pc, response) {
      let standardReport = {};
      let reports = response.result();
      reports.forEach((report) => {
        let standardStats = {
          id: report.id,
          timestamp: report.timestamp.getTime(),
          type: report.type
        };
        report.names().forEach((name) => {
          standardStats[name] = report.stat(name);
        });
        // backfill mediaType -- until https://codereview.chromium.org/1307633007/ lands.
        if (report.type === 'ssrc' && !standardStats.mediaType && standardStats.googTrackId) {
          // look up track kind in local or remote streams.
          let streams = pc.getRemoteStreams().concat(pc.getLocalStreams());
          for (let i = 0; i < streams.length && !standardStats.mediaType; i++) {
            let tracks = streams[i].getTracks();
            for (let j = 0; j < tracks.length; j++) {
              if (tracks[j].id === standardStats.googTrackId) {
                standardStats.mediaType = tracks[j].kind;
                report.mediaType = tracks[j].kind;
              }
            }
          }
        }
        standardReport[standardStats.id] = standardStats;
      });
      return standardReport;
    }

    function dumpStream(stream) {
      return {
        id: stream.id,
        tracks: stream.getTracks().map((track) => {
          return {
            id: track.id, // unique identifier (GUID) for the track
            kind: track.kind, // `audio` or `video`
            label: track.label, // identified the track source
            enabled: track.enabled, // application can control it
            muted: track.muted, // application cannot control it (read-only)
            readyState: track.readyState // `live` or `ended`
          };
        })
      };
    }

    module.exports = function(trace, getStatsInterval, prefixesToWrap) {
      let peerconnectioncounter = 0;
      let isFirefox = !!window.mozRTCPeerConnection;
      let isEdge = !!window.RTCIceGatherer;
      let isSafari = !isFirefox && window.RTCPeerConnection && !window.navigator.webkitGetUserMedia;
      prefixesToWrap.forEach(function(prefix) {
        if (!window[prefix + 'RTCPeerConnection']) {
          return;
        }
        if (prefix === 'webkit' && isEdge) {
          // dont wrap webkitRTCPeerconnection in Edge.
          return;
        }
        let OrigPeerConnection = window[prefix + 'RTCPeerConnection'];
        let peerconnection = (config, constraints) => {
          let pc = new OrigPeerConnection(config, constraints);
          let id = 'PC_' + peerconnectioncounter++;
          pc.__rtcStatsId = id;

          if (!config) {
            config = {nullConfig: true};
          }

          config = JSON.parse(JSON.stringify(config)); // deepcopy
          // don't log credentials
          ((config && config.iceServers) || []).forEach(function(server) {
            delete server.credential;
          });

          if (isFirefox) {
            config.browserType = 'moz';
          } else if (isEdge) {
            config.browserType = 'edge';
          } else {
            config.browserType = 'webkit';
          }

          trace('create', id, config);
          // http://stackoverflow.com/questions/31003928/what-do-each-of-these-experimental-goog-rtcpeerconnectionconstraints-do
          if (constraints) {
            trace('constraints', id, constraints);
          }

          pc.addEventListener('icecandidate', (e) => {
            trace('onicecandidate', id, e.candidate);
          });
          pc.addEventListener('addstream', (e) => {
            trace('onaddstream', id, e.stream.id + ' ' + e.stream.getTracks().map((t) => {
              return t.kind + ':' + t.id;
            }));
          });
          pc.addEventListener('track', (e) => {
            trace('ontrack', id, e.track.kind + ':' + e.track.id + ' ' + e.streams.map((stream) => {
              return 'stream:' + stream.id;
            }));
          });
          pc.addEventListener('removestream', (e) => {
            trace('onremovestream', id, e.stream.id + ' ' + e.stream.getTracks().map((t) => {
              return t.kind + ':' + t.id;
            }));
          });
          pc.addEventListener('signalingstatechange', () => {
            trace('onsignalingstatechange', id, pc.signalingState);
          });
          pc.addEventListener('iceconnectionstatechange', () => {
            trace('oniceconnectionstatechange', id, pc.iceConnectionState);
          });
          pc.addEventListener('icegatheringstatechange', () => {
            trace('onicegatheringstatechange', id, pc.iceGatheringState);
          });
          pc.addEventListener('negotiationneeded', () => {
            trace('onnegotiationneeded', id);
          });
          pc.addEventListener('datachannel', (event) => {
            trace('ondatachannel', id, [event.channel.id, event.channel.label]);
          });

          if (!isEdge) {
            let prev = {};
            let interval = window.setInterval(() => {
              if (pc.signalingState === 'closed') {
                window.clearInterval(interval);
                return;
              }
              if (isFirefox || isSafari) {
                pc.getStats(null).then((res) => {
                  let now = map2obj(res);
                  let base = JSON.parse(JSON.stringify(now)); // our new prev
                  trace('getstats', id, deltaCompression(prev, now));
                  prev = base;
                });
              } else {
                pc.getStats((res) => {
                  let now = mangleChromeStats(pc, res);
                  let base = JSON.parse(JSON.stringify(now)); // our new prev
                  trace('getstats', id, deltaCompression(prev, now));
                  prev = base;
                }, (err) => {
                  // console.log(err);
                });
              }
            }, getStatsInterval);
          }
          return pc;
        };

        ['createDataChannel', 'close'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              trace(method, this.__rtcStatsId, arguments);
              return nativeMethod.apply(this, arguments);
            };
          }
        });

        ['addStream', 'removeStream'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              let stream = arguments[0];
              let streamInfo = stream.getTracks().map((t) => {
                return t.kind + ':' + t.id;
              });

              trace(method, this.__rtcStatsId, stream.id + ' ' + streamInfo);
              return nativeMethod.apply(this, arguments);
            };
          }
        });

        ['addTrack'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              let track = arguments[0];
              let streams = [].slice.call(arguments, 1);
              trace(method, this.__rtcStatsId, track.kind + ':' + track.id + ' ' + (streams.map((s) => {
                return 'stream:' + s.id;
              }).join(';') || '-'));
              return nativeMethod.apply(this, arguments);
            };
          }
        });

        ['removeTrack'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              let track = arguments[0].track;
              trace(method, this.__rtcStatsId, track ? track.kind + ':' + track.id : 'null');
              return nativeMethod.apply(this, arguments);
            };
          }
        });

        ['createOffer', 'createAnswer'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              let rtcStatsId = this.__rtcStatsId;
              let args = arguments;
              let opts;
              if (arguments.length === 1 && typeof arguments[0] === 'object') {
                opts = arguments[0];
              } else if (arguments.length === 3 && typeof arguments[2] === 'object') {
                opts = arguments[2];
              }
              trace(method, this.__rtcStatsId, opts);
              return nativeMethod.apply(this, opts ? [opts] : undefined)
                  .then((description) => {
                    trace(method + 'OnSuccess', rtcStatsId, description);
                    if (args.length > 0 && typeof args[0] === 'function') {
                      args[0].apply(null, [description]);
                      return undefined;
                    }
                    return description;
                  }, (err) => {
                    trace(method + 'OnFailure', rtcStatsId, err.toString());
                    if (args.length > 1 && typeof args[1] === 'function') {
                      args[1].apply(null, [err]);
                      return;
                    }
                    throw err;
                  });
            };
          }
        });

        ['setLocalDescription', 'setRemoteDescription', 'addIceCandidate'].forEach((method) => {
          let nativeMethod = OrigPeerConnection.prototype[method];
          if (nativeMethod) {
            OrigPeerConnection.prototype[method] = function() {
              let rtcStatsId = this.__rtcStatsId;
              let args = arguments;
              trace(method, this.__rtcStatsId, args[0]);
              return nativeMethod.apply(this, [args[0]])
                  .then(() => {
                    trace(method + 'OnSuccess', rtcStatsId);
                    if (args.length >= 2 && typeof args[1] === 'function') {
                      args[1].apply(null, []);
                      return undefined;
                    }
                    return undefined;
                  }, (err) => {
                    trace(method + 'OnFailure', rtcStatsId, err.toString());
                    if (args.length >= 3 && typeof args[2] === 'function') {
                      args[2].apply(null, [err]);
                      return undefined;
                    }
                    throw err;
                  });
            };
          }
        });

        // wrap static methods. Currently just generateCertificate.
        if (OrigPeerConnection.generateCertificate) {
          Object.defineProperty(peerconnection, 'generateCertificate', {
            get: () => {
              return arguments.length ?
                                OrigPeerConnection.generateCertificate.apply(null, arguments)
                                : OrigPeerConnection.generateCertificate;
            }
          });
        }
        window[prefix + 'RTCPeerConnection'] = peerconnection;
        window[prefix + 'RTCPeerConnection'].prototype = OrigPeerConnection.prototype;
      });

      // getUserMedia wrappers
      prefixesToWrap.forEach((prefix) => {
        let name = prefix + (prefix.length ? 'GetUserMedia' : 'getUserMedia');
        if (!navigator[name]) {
          return;
        }
        let origGetUserMedia = navigator[name].bind(navigator);
        let gum = () => {
          trace('getUserMedia', null, arguments[0]);
          let cb = arguments[1];
          let eb = arguments[2];
          origGetUserMedia(arguments[0],
              (stream) => {
                // we log the stream id, track ids and tracks readystate since that is ended GUM fails
                // to acquire the cam (in chrome)
                trace('getUserMediaOnSuccess', null, dumpStream(stream));
                if (cb) {
                  cb(stream);
                }
              },
              (err) => {
                trace('getUserMediaOnFailure', null, err.name);
                if (eb) {
                  eb(err);
                }
              }
          );
        };
        navigator[name] = gum.bind(navigator);
      });

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        let origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let gum = () => {
          trace('navigator.mediaDevices.getUserMedia', null, arguments[0]);
          return origGetUserMedia.apply(navigator.mediaDevices, arguments)
              .then((stream) => {
                trace('navigator.mediaDevices.getUserMediaOnSuccess', null, dumpStream(stream));
                return stream;
              }, (err) => {
                trace('navigator.mediaDevices.getUserMediaOnFailure', null, err.name);
                return Promise.reject(err);
              });
        };
        navigator.mediaDevices.getUserMedia = gum.bind(navigator.mediaDevices);
      }
    };
  }, {}], 3: [function(require, module, exports) {
    let PROTOCOL_VERSION = '1.0';
    module.exports = (wsURL) => {
      let buffer = [];
      let connection = new WebSocket(wsURL + window.location.pathname, PROTOCOL_VERSION);
      connection.onerror = (e) => {};

      connection.onopen = () => {
        while (buffer.length) {
          connection.send(JSON.stringify(buffer.shift()));
        }
      };

      function trace() {
        let args = Array.prototype.slice.call(arguments);
        args.push(new Date().getTime());
        if (connection.readyState === 1) {
          connection.send(JSON.stringify(args));
        } else if (args[0] !== 'getstats') {
          buffer.push(args);
        }
      }
      return trace;
    };
  }, {}]
}, {}, [1]);

},{}],18:[function(require,module,exports){
const rtcStatsReporter = require('./rtcstats-reporter');

/**
 * Collect WebRTC Report data
 * Removes credential information from the STUN.TURN server configuration.
 * performs Delta compression
 *
 * if isCallback is true the report includes a MOS score : trace('mos', mos, report);
 *
 * @param {object} trace the function will be attached to the RTCPeerConnection object and will be used as a callback
 * @param {boolean} isCallback this set to true the reports will be passed uncompressed to the trace function: trace('mos', mos, res);
 * @param {number} getStatsInterval
 * @property {number} mos_report the final mos report to be sent when the stream is closed
 * @property {number} _reportsCount the number of reports taken for mos average
 * @property {number} _mosSum the summary of mos scores
 * @private
 */

class RTCStats {
  constructor(trace, isCallback, getStatsInterval, prefixesToWrap) {
    this.mos_report = {min: 5, max: 0};
    this._reportsCount = 0;
    this._mosSum = 0;
    let self = this;
    if (isCallback) {
      let OrigPeerConnection = window['RTCPeerConnection'];
      let peerconnection = function(config, constraints) {
        let pc = new OrigPeerConnection(config, constraints);
        if (!self.stats_interval) {
          self.stats_interval = window.setInterval(() => {
            if (pc.signalingState === 'closed') {
              window.clearInterval(self.stats_interval);
              let mos_report = self.getMOSReport();
              trace('mos_report', mos_report.last, null, mos_report);
              return;
            }
            pc.getStats(null).then((res) => {
              let mos = self.getMos(res);
              trace('mos', mos, res);
            });
          }, getStatsInterval);
        }
        return pc;
      };
      window['RTCPeerConnection'] = peerconnection;
      window['RTCPeerConnection'].prototype = OrigPeerConnection.prototype;
    } else {
      rtcStatsReporter(trace, isCallback, getStatsInterval, prefixesToWrap);
    }
  }
  disable() {
    if (!this.stats_interval) {
      throw new Error('rtc stats not enabled');
    } else {
      window.clearInterval(this.stats_interval);
      delete this.stats_interval;
    }
  }

  getMos(report) {
    let jitter_time = 0;
    let recv_pkts = 0;
    let lost_pkts = 0;
    let average = 100.0;
    let packet_loss = 0.0;
    let effective_latency = 0.0;
    let r_value = 0.0;
    let mos = 0;

    for (let now of report.values()) {
      if (now.type === 'inbound-rtp') {
        jitter_time = now.jitter;
        lost_pkts = now.packetsLost;
        recv_pkts = now.packetsReceived;
      }
    }

    if (recv_pkts + lost_pkts > 0) {
      packet_loss = 100.0 * (lost_pkts / (recv_pkts + lost_pkts));
    }
    effective_latency = (average + jitter_time * 2 + 10);
    if (effective_latency < 160) {
      r_value = 93.2 - (effective_latency / 40);
    } else {
      r_value = 93.2 - (effective_latency - 120) / 10;
    }
    r_value = r_value - (packet_loss * 2.5);

    if (r_value < 1) {
      r_value = 1;
    }
    mos = 1 + (0.035) * r_value + (0.000007) * r_value * (r_value - 60) * (100 - r_value);
    this.updateMOSReport(mos);
    return RTCStats.normaliseFloat(mos);
  }
    /**
     * Update the mos_report object
     * @param {number} mos the MOS score
     * @returns {object} the report object
     */
  updateMOSReport(mos) {
    this._reportsCount++;
    this._mosSum += mos;
    this.mos_report.last = mos;
    this.mos_report.min = (mos < this.mos_report.min) ? mos : this.mos_report.min;
    this.mos_report.max = (mos > this.mos_report.max) ? mos : this.mos_report.max;
    this.mos_report.average = this._mosSum / this._reportsCount;
    return this.mos_report;
  }
    /**
     * Update the MOS report object
     * mos_report.min - the minimum MOS value during the stream
     * mos_report.max - the maximum MOS value during the stream
     * mos_report.last - the last MOS value during the stream
     * mos_report.average - the average MOS value during the stream
     * @returns {Object} mos_report - a report for the MOS values
     *
     */
  getMOSReport() {
    this.mos_report.min = RTCStats.normaliseFloat(this.mos_report.min);
    this.mos_report.max = RTCStats.normaliseFloat(this.mos_report.max);
    this.mos_report.last = RTCStats.normaliseFloat(this.mos_report.last);
    this.mos_report.average = RTCStats.normaliseFloat(this.mos_report.average);
    return this.mos_report;
  }
  static normaliseFloat(value) {
    return parseFloat(value).toFixed(6);
  }
}
module.exports = RTCStats;

},{"./rtcstats-reporter":17}],19:[function(require,module,exports){
let PROTOCOL_VERSION = '1.0';
module.exports = function(wsURL) {
  let buffer = [];
  let connection = new WebSocket(wsURL + window.location.pathname, PROTOCOL_VERSION);
  connection.onerror = function(e) {
        // console.log('WS ERROR', e);
  };

    /*
    connection.onclose = function() {
      // reconnect?
    };
    */

  connection.onopen = function() {
    while (buffer.length) {
      connection.send(JSON.stringify(buffer.shift()));
    }
  };

    /*
    connection.onmessage = function(msg) {
      // no messages from the server defined yet.
    };
    */

  function trace() {
    // eslint-disable-next-line prefer-rest-params
    let args = Array.prototype.slice.call(arguments);
    args.push(new Date().getTime());
    if (connection.readyState === 1) {
      connection.send(JSON.stringify(args));
    } else if (args[0] !== 'getstats') {
      buffer.push(args);
    }
  }
  return trace;
};

},{}],20:[function(require,module,exports){
(function (global){
/*
 * Nexmo Client SDK
 *  Conversation Client - API Error wrapper
 *
 * Copyright (c) Nexmo Inc.
*/

const NexmoClientErrorTypes = require('./nexmoClientErrorTypes');

function decorateError(instance, error) {
  if (error && error.code) {
    error.type = error.code;
    delete error['code'];
  }
  Object.assign(instance, error);
  instance.message = 'type: ' + instance.type + ', description: ' + (instance.description ? instance.description : '');
  instance.stack = new Error().stack;
}

/**
 * Error constructor of an NexmoClient-error
 * @param {string} errorInput String client error
*/
function NexmoClientError(errorInput) {
  const error = NexmoClientErrorTypes[errorInput];
  // for other errors (libs/browser APIs) re-use the Client error
  // to forward it but don't throw it away
  if (error) {
    // if error type exists in our list keep consistency
    decorateError(this, error);
  } else {
    // if the structure is not as expected, f/w as much as we can get
    this.message = (errorInput && errorInput.message) ? errorInput.message : errorInput;
    this.stack = (errorInput && errorInput.stack) ? errorInput.stack : new Error().stack;
  }

  // make sure the error.name matches the class name
  this.name = 'NexmoClientError';
  if (typeof global.NXMbugsnagClient !== 'undefined') {
    global.NXMbugsnagClient.notify(this, {
      severity: 'info'
    });
  }
}

NexmoClientError.prototype = Object.create(NexmoClientError.prototype);
NexmoClientError.prototype.constructor = NexmoClientError;

/**
 * Error constructor of an API-error
 * @param {object} error API error, always containing {type: <string>}
*/
function NexmoApiError(error) {
  decorateError(this, error);
  // make sure the error.name matches the class name
  this.name = 'NexmoApiError';
  if (typeof global.NXMbugsnagClient !== 'undefined') {
    global.NXMbugsnagClient.notify(this, {
      severity: 'info',
      metaData: {
        'API trace': error.__metadata,
        'rid': error.rid
      }
    });
  }
}

NexmoApiError.prototype = Object.create(NexmoApiError.prototype);
NexmoApiError.prototype.constructor = NexmoApiError;

module.exports = {
  NexmoClientError: NexmoClientError,
  NexmoApiError: NexmoApiError
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./nexmoClientErrorTypes":21}],21:[function(require,module,exports){
/*
 *  Nexmo Client SDK
 *  Nexmo Client Error Types
 *
 * Copyright (c) Nexmo Inc.
 */

const NexmoClientErrorTypes = {
  'error:application:call:params': {
    type: 'error:application:call:params',
    description: 'not a valid String[] of usernames param'
  },
  'error:application:callServer:params': {
    type: 'error:application:call:params',
    description: 'not a valid String of phone number'
  },
  'error:call:reject': {
    type: 'error:call:reject',
    description: 'failed to reject the call'
  },
  'error:getUserMedia:permissions': {
    type: 'error:getUserMedia:permissions',
    description: 'missing getUserMedia permissions'
  },
  'error:media:params': {
    type: 'error:media:params',
    description: 'currently supported params media type= {audio:{muted:false, earmuffed:false}}'
  },
  'error:self': {
    type: 'error:self',
    description: 'Conversation Object is missing self (me)'
  },
  'error:user:relogin': {
    type: 'error:user:relogin',
    description: 'please relogin'
  },
  'error:seen:own-message': {
    type: 'error:seen:own-message',
    description: 'attempt to send seen for own message'
  },
  'error:already-seen': {
    type: 'error:already-seen',
    description: 'already marked as seen'
  },
  'error:delivered:own-message': {
    type: 'error:delivered:own-message',
    description: 'attempt to send delivered for own message'
  },
  'error:already-delivered': {
    type: 'error:already-delivered',
    description: 'already marked as delivered'
  },
  'error:fetch-image': {
    type: 'error:fetch-image',
    description: 'xhr.status received other than 200'
  },
  'error:delete-image': {
    type: 'error:delete-image',
    description: 'xhr.status received other than 204'
  },
  'error:missing:params': {
    type: 'error:missing:params',
    description: 'missing parameters'
  },
  'error:invite:missing:params': {
    type: 'error:missing:params',
    description: 'This invite cannot be sent to empty username and user_id'
  },
  'error:invalid:param:type': {
    type: 'error:invalid:param:type',
    description: 'Invalid Object type, passed in the parameters'
  },
  'error:audio:already-connecting': {
    type: 'error:audio:already-connecting',
    description: 'Audio call already in progress'
  },
  'error:audio:not-enabled': {
    type: 'error:audio:not-enabled',
    description: 'Audio is not enabled'
  },
  'error:media:already-connecting': {
    type: 'error:media:already-connecting',
    description: 'Media is already in progress'
  },
  'error:media:unsupported-browser': {
    type: 'error:media:unsupported-browser',
    description: 'This action is not supported on this browser'
  },
  'error:media:extension': {
    type: 'error:media:extension',
    description: 'Chrome extension has thrown an error'
  },
  'error:media:extension-not-installed': {
    type: 'error:media:extension-not-installed',
    description: 'Chrome extension should be installed'
  },
  'error:media:update:streams': {
    type: 'error:media:update:streams',
    description: 'cant update more than one stream'
  },
  'error:media:update:unsupported': {
    type: 'error:media:update:unsupported',
    description: 'params are not valid for update - need video or screenshare'
  },
  'error:media:update:invalid': {
    type: 'error:media:update:invalid',
    description: 'state of media is not supported for this update'
  },
  'error:media:stream:not-found': {
    type: 'error:media:stream:not-found',
    description: 'A stream with the given index was not found'
  },
  'error:audio:dtmf:invalid-digit': {
    type: 'error:audio:dtmf:invalid-digit',
    description: 'not a valid string of dtmf digits (0-9,a-d,A-D,p,P,*,#)'
  },
  'error:invalid-order': {
    type: 'error:invalid-order',
    description: 'params not valid. Order must be asc or desc'
  },
  'error:custom-event:invalid': {
    type: 'error:custom-event:invalid',
    description: 'Custom event type not valid'
  }
};

module.exports = NexmoClientErrorTypes;

},{}],22:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

const Page = require('./page');

/**
 * A Conversations Page
 *
 * @class ConversationsPage
 * @param {Map} items map of conversations fetched in the paginated query
 * @extends Page
*/
class ConversationsPage extends Page {
  constructor(params) {
    super(params);

    this.items = new Map();
    // Iterate and create the conversations if not existent
    params.items.forEach((c) => {
      const conversation = this.application.updateOrCreateConversation(c);
      this.items.set(conversation.id, conversation);
    });
  }

  /**
   * Fetch the previous page if exists
   * @returns {Promise<Page>}
  */
  getPrev() {
    if (!this.hasPrev()) return this._getError();
    return this.application.getConversations(this._getConfig(this.cursor.prev));
  }

  /**
   * Fetch the next page if exists
   * @returns {Promise<Page>}
  */
  getNext() {
    if (!this.hasNext()) return this._getError();
    return this.application.getConversations(this._getConfig(this.cursor.next));
  }
}

module.exports = ConversationsPage;

},{"./page":24}],23:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

const Page = require('./page');
const NXMEvent = require('../events/nxmEvent');
const TextEvent = require('../events/text_event');
const ImageEvent = require('../events/image_event');

/**
 * A Events Page
 *
 * @class EventsPage
 * @param {Map} items map of events fetched in the paginated query
 * @extends Page
*/
class EventsPage extends Page {
  constructor(params) {
    super(params);
    this.items = new Map();
    this.conversation = params.conversation;

    // Iterate and create the event objects
    params.items.forEach((event) => {
      switch (event.type) {
                // NXMEvent types with corresponding classes
        case 'text':
          this.items.set(event.id, new TextEvent(this.conversation, event));
          break;
        case 'image':
          this.items.set(event.id, new ImageEvent(this.conversation, event));
          break;
        default:
          this.items.set(event.id, new NXMEvent(this.conversation, event));
          break;
      }
    });

    // update the events Map on the conversation
    this.conversation.events = new Map([...this.conversation.events, ...this.items]);
  }

  /**
    * Fetch the previous page if exists
    * @returns {Promise<Page>}
  */
  getPrev() {
    if (!this.hasPrev()) return this._getError();
    return this.conversation.getEvents(this._getConfig(this.cursor.prev));
  }

  /**
    * Fetch the next page if exists
    * @returns {Promise<Page>}
  */
  getNext() {
    if (!this.hasNext()) return this._getError();
    return this.conversation.getEvents(this._getConfig(this.cursor.next));
  }
}

module.exports = EventsPage;

},{"../events/image_event":3,"../events/nxmEvent":4,"../events/text_event":5,"./page":24}],24:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

const NexmoApiError = require('../nexmoClientError').NexmoApiError;

/** Page Class for Paginated Results
 *
 * @class Page
 * @param {number} page_size the number of resources returned in a single request list
 * @param {string} order 'asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} cursor cursor parameter to access the next or previous page of a data set
 * @param {Application} application - the parent Application
 * @param {string} [event_type] the type of event used to filter event requests
 *
 * @private
*/
class Page {
  constructor(params = {}) {
    this.page_size = params.page_size;
    this.order = params.order;
    this.cursor = params.cursor;
    this.application = params.application;

    if (params.event_type && params.event_type.length > 0) {
      this.event_type = params.event_type;
    }
  }

  /**
    * Check if previous page exists
    * @returns {Boolean}
  */
  hasPrev() {
    return this.cursor.prev ? this.cursor.prev.length > 0 : false;
  }

  /**
    * Check if next page exists
    * @returns {Boolean}
  */
  hasNext() {
    return this.cursor.next ? this.cursor.next.length > 0 : false;
  }

  /**
    * Create config params for paginationRequest
    * @param {string} cursor cursor parameter to access the next or previous page of a data set
    * @returns {Object}
  */
  _getConfig(cursor) {
    const config = {
      page_size: this.page_size,
      order: this.order,
      cursor: cursor
    };
    if (this.event_type) {
      config.event_type = this.event_type;
    }
    return config;
  }

  /**
    * Create a nexmoClientError when page does not exist
  */
  _getError() {
    return Promise.reject(
        new NexmoApiError({
          type: 'error:invalid-cursor',
          description: 'page does not exist'
        })
    );
  }
}

module.exports = Page;

},{"../nexmoClientError":20}],25:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *
 * Copyright (c) Nexmo Inc.
*/

/** Config Class for Paginated Requests
 *
 * @class PageConfig
 * @param {number} page_size=10 the number of resources returned in a single request list
 * @param {string} order=asc the asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} cursor='' cursor parameter to access the next or previous page of a data set
 * @param {string} [event_type] the type of event used to filter event requests
 * @private
*/
class PageConfig {
  constructor(params = {}) {
    this.page_size = params.page_size || 10;
    this.order = params.order || 'asc';
    this.cursor = params.cursor || '';
    if (params.event_type) {
      this.event_type = params.event_type;
    }
  }
}

module.exports = PageConfig;

},{}],26:[function(require,module,exports){
(function (global){
/*
 * Nexmo Client SDK
 *  Main wrapper
 *
 * Copyright (c) Nexmo Inc.
*/

const WildEmitter = require('wildemitter');
const socket_io = require('socket.io-client');
const logger = require('loglevel');
const prefix = require('loglevel-plugin-prefix');
const bugsnag = require('@bugsnag/js');
const Utils = require('./utils');
const Application = require('./application');
const ErrorsEmitter = require('./modules/errors_emitter');
const User = require('./user');
const NexmoClientError = require('./nexmoClientError').NexmoClientError;
const NexmoApiError = require('./nexmoClientError').NexmoApiError;

prefix.reg(logger);

prefix.apply(logger, {
  template: '[%t] %l (NXM-%n):',
  timestampFormatter: (date) => {
    return date.toTimeString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, '$1');
  },
  levelFormatter: (level) => {
    return level.toUpperCase();
  },
  nameFormatter: (name) => {
    return name || 'SDK';
  }
});

/**
 * The parent NexmoClient class.
 *
 * @class NexmoClient
 * @param {object} params the settings to initialise the SDK
 * @param {Boolean} params.debug=false set mode to debug
 * @param {string} params.url='nexmo_ws_url' Nexmo Conversation Websocket url
 * @param {string} params.nexmo_api_url=Nexmo Conversation Api url
 * @param {string} params.path='/rtc' Nexmo Conversation Websocket url path suffix
 * @param {object} params.rtcstats set reporting for stream statistics (Websocket or internal event emit)
 * @param {string} params.rtcstats.ws_url endpoint (websocket) to send rtc stats.
 * @param {Boolean} params.rtcstats.emit_events=false receive rtcstats:report event

 * @param {object} params.socket_io configure socket.io
 * @param {Boolean} params.socket_io.forceNew=true configure socket.io forceNew attribute
 * @param {Boolean} params.socket_io.autoConnect=true socket.io autoConnect attribute
 * @param {Boolean} params.socket_io.reconnection=true socket.io reconnection attribute
 * @param {number} params.socket_io.reconnectionAttempts=5 socket.io reconnectionAttempts attribute
 * @param {string[]} params.socket_io.transports='websocket' socket.io transports protocols
 * @param {string[]} params.sync='lite' {'lite' || 'full' || 'none'} after a successful login, synchronise conversations , include events or nothing
 * @param {string} params.ips_url='ips_url' Nexmo IPS url for image upload
 * @param {string} params.environment='production' development / production environment
 * @param {object} params.iceServers=[{'stun:stun.l.google.com:19302'}] iceServers for RTCPeerConnection
 * @param {object} params.callstats configure callstats.io integration
 * @param {Boolean} params.callstats.enabled=false
 * @param {string} params.callstats.AppID your callstats AppID
 * @param {string} params.callstats.AppSecret your callstats AppSecret
 * @param {object} params.log_reporter configure log reports for bugsnag tool
 * @param {Boolean} params.log_reporter.enabled=true
 * @param {string} params.log_reporter.bugsnag_key your bugsnag api key / defaults to Nexmo api key
 * @param {object} params.conversations_page_config configure paginated requests for conversations
 * @param {number} params.conversations_page_config.page_size=10 the number of resources returned in a single request list
 * @param {string} params.conversations_page_config.order=asc 'asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} params.conversations_page_config.cursor cursor parameter to access the next or previous page of a data set
 * @param {object} params.events_page_config configure paginated requests for events
 * @param {number} params.events_page_config.page_size=10 the number of resources returned in a single request list
 * @param {string} params.events_page_config.order=asc 'asc' or 'desc' ordering of resources (usually based on creation time)
 * @param {string} params.events_page_config.event_type the type of event used to filter event requests. Supports wildcard options with :* eg. 'members:*'
 *
 * @emits NexmoClient#connecting
 * @emits NexmoClient#disconnect
 * @emits NexmoClient#error
 * @emits NexmoClient#ready
 * @emits NexmoClient#reconnect
 * @emits NexmoClient#reconnecting
*/
class NexmoClient {
  constructor(params) {
    // save an array of instances
    const inputParams = params || {};
    this.config = {
      debug: false,
      callstats: {
        enabled: false,
        AppID: '',
        AppSecret: ''
      },
      log_reporter: {
        enabled: false,
        bugsnag_key: null
      },
      environment: 'production',
      ips_url: 'https://api.nexmo.com/v1/image',
      nexmo_api_url: 'https://api.nexmo.com',
      path: '/rtc',
      repository: 'https://github.com/Nexmo/conversation-js-sdk',
      socket_io: {
        reconnection: true,
        reconnectionAttempts: 5,
        forceNew: true,
        autoConnect: true,
        transports: ['websocket']
      },
      screenShareExtensionId: '',
      SDK_version: '6.0.1',
      sync: 'lite',
      url: 'https://ws.nexmo.com',
      iceServers: [{
        urls: 'stun:stun.l.google.com:19302'
      }],
      rtcstats: {
        ws_url: '',
        emit_events: false
      },
      conversations_page_config: {
        page_size: 10,
        order: 'asc',
        cursor: ''
      },
      events_page_config: {
        page_size: 10,
        order: 'asc',
        event_type: ''
      }
    };

    this.sessionReady = false;
    this.session_id = null;
    this.requests = {};
    this.application = null;


    if (inputParams.debug === true) {
      logger.setLevel('debug');
    } else {
      logger.setLevel('silent');
    }
    this.log = logger.noConflict();

    // set our config from the inputParams
    this.config = Utils.deepMergeObj(this.config, this._sanitizeConfig(inputParams));

    // inject callstats library
    if (this.config.callstats.enabled) {
      Utils.injectScript('//api.callstats.io/static/callstats.min.js', () => {
        if (typeof callstats !== 'undefined') {
          // eslint-disable-next-line new-cap
          this.callstats = new callstats();
        }
      });
    }

    // inject bug reporting tool
    if (this.config.log_reporter.enabled) {
      global.NXMbugsnagClient = bugsnag({
        apiKey: this.config.log_reporter.bugsnag_key || Utils._getBugsnagKey(),
        appVersion: this.config.SDK_version,
        releaseStage: this.config.environment
      });
    }

    this._createAndSetConnection();

    WildEmitter.mixin(NexmoClient);
  }

	/**
	 * Creates and sets the socket_io connection
	 *
	 * @private
	*/
  _createAndSetConnection() {
    let connection;

    // Create the socket.io connection and allow multiple instances
    let socket_io_config = Object.assign({
      path: this.config.path
    }, this.config.socket_io);
    connection = socket_io.connect(this.config.url, socket_io_config);

    this.connection = connection;

		/**
		 * Ready event.
		 *
		 * @event NexmoClient#ready
		 * @example <caption>Listen to websocket ready event </caption>
		 *     rtc.on("ready", () => {
		 *      console.log("connection ready");
		 *     });
		*/
    connection.on('connect', () => {
      this.emit('ready');
      this.sessionReady = true;
      this.log.info('websocket ready');
    });

    // Listen to socket.io events
		/**
		 * Connecting event.
		 *
		 * @event NexmoClient#connecting
		 * @example <caption>Listen to websocket connecting event </caption>
		 *     rtc.on("connecting", () => {
		 *      console.log("connecting");
		 *     });
		*/
    connection.on('connecting', () => {
      this.emit('connecting');
      this.log.info('websocket connecting');
    });

		/**
		 * Disconnect event.
		 *
		 * @event NexmoClient#disconnect
		 * @example <caption>Listen to websocket disconnect event </caption>
		 *     rtc.on("disconnect", () => {
		 *      console.log("disconnect");
		 *     });
		*/
    connection.on('disconnect', () => {
      this.emit('disconnect');
      this.log.info('websocket disconnected');
    });

		/**
		 * Reconnect event.
		 *
		 * @event NexmoClient#reconnect
		 * @example <caption>Listen to websocket reconnect event </caption>
		 *     rtc.on("reconnect", (retry_number) => {
		 *      console.log("reconnect", retry_number);
		 *     });
		*/
    connection.on('reconnect', (retry_number) => {
      this.emit('reconnect', retry_number);
      this.log.info('websocket reconnect');
    });

		/**
		 * Reconnecting event.
		 *
		 * @event NexmoClient#reconnecting
		 * @example <caption>Listen to websocket reconnecting event </caption>
		 *     rtc.on("reconnecting", (retry_number) => {
		 *      console.log("reconnecting", retry_number);
		 *     });
		*/
    connection.on('reconnecting', (retry_number) => {
      this.emit('reconnecting', retry_number);
      this.log.info('websocket reconnecting');
    });

		/**
		 * Error event.
		 *
		 * @event NexmoClient#error
		 * @example <caption>Listen to websocket error event </caption>
		 *     rtc.on("error", (error) => {
		 *      console.log("error", error);
		 *     });
		*/
    connection.on('error', (error) => {
      this.emit('error', new NexmoClientError(error));
      this.log.error('Socket.io reported a generic error', error);
    });

    connection.io.on('packet', (packet) => {
      if (packet.type !== 2) return;
      if (packet.data[0] === 'echo') return; // ignore echo events
      const response = packet.data[1];
      // Set the type of the response
      response.type = packet.data[0];
      this.log.debug('<--', response.type, response);
      if (response.rid in this.requests) {
        const callback = this.requests[response.rid].callback;
        delete this.requests[response.rid];
        delete response.delay;
        if (this.errorsEmitter) {
          this.errorsEmitter.emitResponseIfError(response);
        }
        callback(response);
      } else {
        // This is an unsolicited event
        // we emit it in application level.
        if (this.application) {
          this.application._handleEvent(response);
        }
      }
    });

    return connection;
  }

	/**
	 * Revert any invalid params to our default
	 *
	 * @param {object} config the object to sanitize
	 * @private
	*/
  _sanitizeConfig(incomingConfig) {
    // make sure we allow specific values for the params

    // Sync
    let sanitizedConfig = incomingConfig;
    if (incomingConfig.sync && ['lite', 'full', 'none'].indexOf(incomingConfig.sync) === -1) {
      this.log.warn(`invalid param '${incomingConfig.sync}' for sync, reverting to ${this.config.sync}`);
      sanitizedConfig.sync = this.config.sync;
    }
    return sanitizedConfig;
  }

	/**
	 * Conversation listening for text events.
	 *
	 * @event Conversation#text
	 *
	 * @property {Member} sender - The sender of the text
	 * @property {TextEvent} text - The text message received
	 * @example <caption>listen for text events</caption>
	 * conversation.on("text",(sender, message) => {
	 *      console.log(sender,message);
	 *
	 * // Identify your own message.
	 *      if (message.from !== conversation.me.id)
	 *
	 * // Identify if the event corresponds to the currently open conversation.
	 *      if (message.cid === conversation.id)
	 * });
	 */

	/**
	 *
	 *  Conversation listening for image events.
	 *
	 * @event Conversation#image
	 *
	 * @property {Member} sender - The sender of the image
	 * @property {ImageEvent} image - The image message received
	 * @example <caption>listen for image events</caption>
	 * conversation.on("image", (sender, image) => {
	 *      console.log(sender,image);
	 *
	 * // Identify your own imageEvent.
	 *      if (image.from !== conversation.me.id)
	 *
	 *  // Identify if the event corresponds to the currently open conversation.
	 *      if (image.cid === conversation.id)
	 * });
	 */

	/**
	 * Conversation listening for deleted events.
	 *
	 * @event Conversation#event:delete
	 *
	 * @property {Member} member - the member who deleted an event
	 * @property {NXMEvent} event - deleted event: event.id
	 * @example <caption>get details about the deleted event</caption>
	 * conversation.on("event:delete", (member, event) => {
	 *      console.log(event.id);
	 *      console.log(event.body.timestamp.deleted);
	 * });
	 */

	/**
	 * Conversation listening for new members.
	 *
	 * @event Conversation#member:joined
	 *
	 * @property {Member} member - the member that joined
	 * @property {NXMEvent} event - the join event
	 * @example <caption>get the name of the new member</caption>
	 * conversation.on("member:joined", (member, event) => {
	 * 		console.log(event.id)
	 *      console.log(member.user.name+ " joined the conversation");
	 * });
	 */

	/**
	 * Conversation listening for members being invited.
	 *
	 * @event Conversation#member:invited
	 *
	 * @property {Member} member - the member that is invited
	 * @property {NXMEvent} event - data regarding the receiver of the invitation
	 * @example <caption>get the name of the invited member</caption>
	 * conversation.on("member:invited", (member, event) => {
	 *      console.log(member.user.name + " invited to the conversation");
	 * });
	 */

	/**
	 * Conversation listening for members callStatus changes.
	 *
	 * @event Conversation#member:call:status
	 *
	 * @property {Member} member - the member that has left
	 * @example <caption>get the callStatus of the member that changed call status</caption>
	 * conversation.on("member:call:status", (member) => {
   *      console.log(member.callStatus);
	 * });
	 */

  /**
   * Conversation listening for members leaving (kicked or left).
   *
   * @event Conversation#member:left
   *
   * @property {Member} member - the member that has left
   * @property {NXMEvent} event - data regarding the receiver of the invitation
   * @example <caption>get the username of the member that left</caption>
   * conversation.on("member:left", (member , event) => {
   *      console.log(member.user.name + " left");
   *      console.log(event.body.reason);
   * });
   */

	/**
	 * Conversation listening for members typing.
	 *
	 * @event Conversation#text:typing:on
	 *
	 * @property {Member} member - the member that started typing
	 * @property {NXMEvent} event - the start typing event
	 * @example <caption>get the username of the member that is typing</caption>
	 * conversation.on("text:typing:on", (data) => {
	 *      console.log(data.name + " is typing...");
	 * });
	 */

	/**
	 * Conversation listening for members stopped typing.
	 *
	 * @event Conversation#text:typing:off
	 *
	 * @property {Member} member - the member that stopped typing
	 * @property {NXMEvent} event - the stop typing event
	 * @example <caption>get the username of the member that stopped typing</caption>
	 * conversation.on("text:typing:off", (data) => {
	 *      console.log(data.name + " stopped typing...");
	 * });
	 */

	/**
	 * Conversation listening for members' seen texts.
	 *
	 * @event Conversation#text:seen
	 *
	 * @property {Member} member - the member that saw the text
	 * @property {TextEvent} text - the text that was seen
	 * @example <caption>listen for seen text events</caption>
	 * conversation.on("text:seen", (data, text) => {
	 *      console.log(text);
	 *
	 * // Check if the event belongs to this conversation
	 *      if (text.cid === conversation.id)
	 *
	 * // Get the list of members that have seen this event
	 *      for (let member_id in text.state.seen_by) {
	 *          if (conversation.me.id !== member_id) {
	 *              console.log(conversation.members.get(member_id).name);
	 *          }
	 *       }
	 * });
	 */

	/**
	 * Conversation listening for members' seen images.
	 * @event Conversation#image:seen
	 *
	 * @property {Member} member - the member that saw the image
	 * @property {ImageEvent} image - the image that was seen
	 * @example <caption>listen for seen image events</caption>
	 * conversation.on("image:seen", (data, image) => {
	 *      console.log(image);
	 *
	 * // Check if the event belongs to this conversation
	 *      if (image.cid === conversation.id)
	 * // Get the list of members that have seen this event
	 *      for (let member_id in image.state.seen_by) {
	 *           if (conversation.me.id !== member_id) {
	 *               console.log(conversation.members.get(member_id).name);
	 *            }
	 *       }
	 * });
	 */

	/**
	 * Conversation listening for members media changes (audio, video,text)
	 *
	 * Change in media presence state. They are in the conversation with text, audio or video.
	 *
	 * @event Conversation#member:media
	 *
	 * @property {Member} member - the member object linked to this event
	 * @property {NXMEvent} event - information about media presence state
	 * @property {boolean} event.body.audio  - is audio enabled
	 * @example <caption>get every member's media change events </caption>
	 * conversation.on("member:media", (from, event) => {
	 *      console.log(from.media.audio_settings.enabled); //true
	 * 		console.log(event.body.media); //{"audio_settings": {"enabled": true, "muted": false, "earmuffed": false}}
	 * });
	 */

	/**
	 * Conversation listening for mute on events
	 * A member has muted their audio
	 *
	 * @event Conversation#audio:mute:on
	 *
	 * @property {Member} member - the member object linked to this event
	 * @property {NXMEvent} event - information about the mute event
	 */

	/**
	 * Conversation listening for mute off events
	 * A member has unmuted their audio
	 *
	 * @event Conversation#audio:mute:off
	 *
	 * @property {Member} member - the member object linked to this event
	 * @property {NXMEvent} event - information about the mute event
	 */

  sendRequest(request, callback) {
    // Add a message ID to the request and set up a listener for the reply (or error)
    request.tid = Utils.allocateUUID();
    const type = request.type;
    delete request.type;
    this.log.debug('-->', type, request);
    this.log.info('-->', type, request.tid);
    this.connection.emit(type, request);
    this.requests[request.tid] = {
      type: type,
      request: request,
      callback: callback
    };
  }

  sendNetworkRequest(params) {
    const version = params.version || 'beta';
    const url = `${this.config.nexmo_api_url}/${version}/${params.path}`;
    if (!(params.type === 'GET' || params.type === 'DELETE')) {
      if (params.data) {
        params.data.originating_session = this.session_id;
      } else {
        params.data = {
          originating_session: this.session_id
        };
      }
    }

    return new Promise((resolve, reject) => {
      return Utils.networkRequest({
        type: params.type,
        url,
        data: (params.data) ? params.data : null,
        token: (params.data || {}).token ? params.data.token : this.config.token || null
      }).then(({response}) => {
        resolve(response);
      }).catch(({response}) => {
        reject(response);
      });
    });
  }

	/**
	 * Login to the cloud.
	 * @param {string} token - the login token
	 * @returns  {Promise<Application>} - the application we logged in
	*/
  login(token) {
    // Create connection if needed
    if (typeof this.connection === 'undefined') {
      this._createAndSetConnection();
    }

    // return a promise for the application
    return new Promise((resolve, reject) => {
      this.log.info(`Client-SDK Version: ${this.config.SDK_version}`);
      Utils.cleanupToken();

      this.sendRequest({
        type: 'session:login',
        body: {
          token,
          SDK_version: this.config.SDK_version,
          OS_family: 'js',
          OS_revision: (typeof navigator !== 'undefined') ? navigator.userAgent : (typeof window !== 'undefined') ? window.navigator.userAgent : 'Generic JS navigator'
        }
      }, (response) => {
        if (response.type === 'session:success') {
          this.session_id = response.body.id;
          this.config.token = this.config.nexmo_api_url.includes('npe') ? token : null;

          if (!this.application || (this.application.me && this.application.me.id !== response.body.user_id)) {
            this.application = new Application(this);
          }
          if (!this.application.me) {
            this.application.me = new User(
                this.application, {
                  id: response.body.user_id,
                  name: response.body.name
                });
          }
          if (!this.errorsEmitter) {
            this.errorsEmitter = new ErrorsEmitter(this.application);
          }

          if (typeof (this.callstats) !== 'undefined') {
            const csStatsInit = (csError, csErrMsg) => {
              this.log.info(`Status: errCode= ${csError} errMsg= ${csErrMsg}`);
            };
            const reportType = {
              inbound: 'inbound',
              outbound: 'outbound'
            };

            // callback function to receive the stats
            const csStatsCallback = (stats) => {
              let ssrc;
              for (ssrc in stats.streams) {
                this.log.info('SSRC is: ', ssrc);
                let dataSsrc = stats.streams[ssrc];
                this.log.info('SSRC Type ', dataSsrc.reportType);
                if (dataSsrc.reportType === reportType.outbound) {
                  this.log.info('RTT is: ', dataSsrc.rtt);
                } else if (dataSsrc.reportType === reportType.inbound) {
                  this.log.info('Inbound loss rate is: ', dataSsrc.fractionLoss);
                }
              }
            };
            const configParams = {
              disableBeforeUnloadHandler: true, // disables callstats.js's window.onbeforeunload parameter.
              applicationVersion: this.config.SDK_version, // the SDK version.
              disablePrecalltest: true // disables the pre-call test, it is enabled by default
            };

            this.callstats.initialize(this.config.callstats.AppID, this.config.callstats.AppSecret, this.application.me.id, csStatsInit, csStatsCallback, configParams);
          }

          // Set Bugsnag user to application.me.id
          if (this.config.log_reporter.enabled) {
            global.NXMbugsnagClient.user = {
              id: this.application.me.id,
              name: this.application.me.name,
              session_id: response.body.id
            };
          }
          return this._updateTokenInStorage(token, response.body.name).then((token) => {
            if (this.config.sync !== 'none') {
              // Retrieve the existing conversation data for this user
              return this.application.getConversations().then(() => {
                resolve(this.application);
              }).catch((reason) => {
                reject(reason);
              });
            } else {
              resolve(this.application);
            }
          });
        } else {
          reject(new NexmoApiError(response));
        }
      });
    });
  }

	/**
	 * logout from the cloud.
	*/
  logout() {
    return new Promise((resolve, reject) => {
      const logoutRequest = () => {
        return this.sendRequest({
          type: 'session:logout',
          body: {}
        }, (response) => {
          if (response.type === 'session:logged-out' || response.type === 'session:terminated') {
            this.disconnect();
            delete this.errorsEmitter;
            delete this.application;
            delete this.connection;
            this.callbacks = {};
            this.requests = {};
            this.sessionReady = false;
            resolve(response);
          } else {
            reject(response);
          }
        });
      };

      // prepare for logout
      if (this.application) {
        let disablePromises = [];

        if (this.application.conversations.size) {
          for (let conversation of this.application.conversations.values()) {
            disablePromises.push(conversation.media.disable());
          }
        }
        return Promise.all(disablePromises).catch((err) => {
          this.log.info(err);
        }).then(() => {
          return logoutRequest();
        });
      } else {
        return logoutRequest();
      }
    });
  }

	/**
	 * Disconnect from the cloud.
	 *
	*/
  disconnect() {
    return this.connection.disconnect();
  }

	/**
	 * Connect from the cloud.
	 *
	*/
  connect() {
    return this.connection.connect();
  }

	/**
	 * Update or Set the stored token
	 *
	 * @param {string} token the token to set
	 * @param {string} username the username to whom the token belongs to
   * @private
	*/
  _updateTokenInStorage(token, username) {
    return Promise.resolve(
        Utils.updateToken({
          token,
          username
        })
    );
  }
}

module.exports = NexmoClient;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./application":1,"./modules/errors_emitter":13,"./nexmoClientError":20,"./user":27,"./utils":28,"@bugsnag/js":30,"loglevel":52,"loglevel-plugin-prefix":51,"socket.io-client":59,"wildemitter":100}],27:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  User Object Model
 *
 * Copyright (c) Nexmo Inc.
 */

const WildEmitter = require('wildemitter');

class User {
  constructor(application, params) {
    this.application = application;
    Object.assign(this, params);
    WildEmitter.mixin(User);
  }
}
module.exports = User;

},{"wildemitter":100}],28:[function(require,module,exports){
/*
 * Nexmo Client SDK
 *  Utility functions
 *
 * Copyright (c) Nexmo Inc.
*/

const uuid = require('uuid');
const NexmoClientError = require('./nexmoClientError').NexmoClientError;

/**
 * Utilities class for the SDK.
 *
 * @class Utils
 * @private
*/
class Utils {
  /**
   * Get the Member from the username of a conversation
   *
   * @param {string} username the username of the member to get
   * @param {Conversation} conversation the Conversation to search in
   * @returns {Member} the requested Member
   * @static
  */
  static getMemberFromNameOrNull(conversation, username) {
    if (!conversation || !username) return null;
    for (let member of conversation.members.values()) {
      if (member.user.name === username) {
        return member;
      }
    }
    return null;
  }

  /**
   * Get the Member's number or uri from the event's channel field
   *
   * @param {object} channel the event's channel field
   * @returns {string} the requested Member number or uri
   * @static
  */
  static getMemberNumberFromEventOrNull(channel) {
    const from = channel && channel.from;
    if (from && (from.number || from.uri)) {
      return from.number || from.uri;
    }
    return null;
  }

  /**
   * Perform a network request to the given url
   *
   * @param {object} reqObject the object that has all the information for the request
   * @param {string} url the request url
   * @param {string} type=GET|POST|PUT|DELETE the types of the network request
   * @param {object} [data] the data that are going to be sent
   * @param {string} [responseType] the response type of the request
   * @param {string} [token] the user token
   * @returns {Promise<XMLHttpRequest.response>} the XMLHttpRequest.response
   * @static
  */
  static networkRequest(reqObject) {
    return Utils.getToken(reqObject.token).then((token) => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let data;
        xhr.open(reqObject.type, reqObject.url, true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);

        if (reqObject && reqObject.url.includes('image')) {
          xhr.responseType = '';
          data = reqObject.data;
          xhr.onloadstart = () => {
            resolve(xhr);
          };
        } else {
          xhr.responseType = reqObject.responseType || 'json';
          data = JSON.stringify(reqObject.data) || null;
          xhr.setRequestHeader('Content-type', 'application/json; charset=utf-8');
        }

        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 204) {
            resolve(xhr);
          } else {
            reject(xhr);
          }
        };
        xhr.onerror = (error) => {
          reject(error);
        };
        xhr.send(data);
      });
    });
  }

  /**
   * Perform a GET network request directly to CS
   *
   * @param {string} url the request url to CS
   * @param {object} [params] network request params
   * @param {string} [params.cursor] cursor parameter to access the next or previous page of a data set
   * @param {number} [params.page_size] the number of resources returned in a single request list
   * @param {string} [params.order] 'asc' or 'desc' ordering of resources (usually based on creation time)
   * @param {string} [params.event_type] the type of event used to filter event requests ('member:joined', 'audio:dtmf', etc)
   *
   * @returns {Promise<XMLHttpRequest.response>} the XMLHttpRequest.response
   * @static
   * @example <caption>Sending a nexmo GET request</caption>
   *    paginationRequest(url, params).then((response) => {
   *      response.items: {},
   *      response.cursor: {
   *          prev: '',
   *          next: '',
   *          self: ''
   *      },
   *      response.page_size: 10,
   *      response.order: 'asc',
   *   });
  */
  static paginationRequest(url, params) {
    return Utils.networkRequest({
      type: 'GET',
      url: Utils.addUrlSearchParams(url, params)
    }).then((xhr) => {
      const {page_size, _embedded, _links} = xhr.response;
      const resource = url.split('/').pop().trim();
      const response = {
        items: _embedded.data[resource],
        cursor: {
          prev: _links.prev ? new URLSearchParams(_links.prev.href).get('cursor') : '',
          next: _links.next ? new URLSearchParams(_links.next.href).get('cursor'): '',
          self: _links.self ? new URLSearchParams(_links.self.href).get('cursor') : ''
        },
        page_size: page_size,
        order: params.order || 'asc'
      };
      if (params.event_type) {
        response.event_type = params.event_type;
      }
      return Promise.resolve(response);
    }).catch(({response})=> {
      const parsed_error = response
        ? response
        : {type: 'error:network:get-request', description: 'network error on nexmo get request'};

      if (parsed_error.validation) {
        parsed_error.description = parsed_error.validation[Object.keys(parsed_error.validation)[0]];
      }
      return Promise.reject(parsed_error);
    });
  }

  /**
   * Update the Search Params of a url
   * @returns {string} the appended url
   * @static
  */
  static addUrlSearchParams(url, params = {}) {
    let appended_url = new URL(url);
    Object.keys(params).forEach((key) => {
      if (params[key] && !(typeof params[key] === 'string' && params[key].length < 1) && params[key] !== null) {
        appended_url.searchParams.set(key, params[key]);
      }
    });
    return appended_url.href;
  }

  /**
   * Deep merges two objects
   * @returns {obj} the new merged object
   * @static
  */
  static deepMergeObj(obj1, obj2) {
    const mergedObj = JSON.parse(JSON.stringify(obj1));
    // Merge the object into the new mergedObject
    for (let prop in obj2) {
      // If the property is an object then merge properties
      if (Object.prototype.toString.call(obj2[prop]) === '[object Object]') {
        mergedObj[prop] = Utils.deepMergeObj(mergedObj[prop], obj2[prop]);
      } else {
        mergedObj[prop] = obj2[prop];
      }
    }
    return mergedObj;
  }

  /**
   * Get the stored token
   * @returns {string} the token
   * @static
  */
  static getToken(token) {
    if (token) {
      return Promise.resolve(token);
    } else {
      if (!localStorage.getItem('NXMO_user_data')) {
        return Promise.reject(new NexmoClientError('error:user:relogin'));
      } else {
        return Promise.resolve(JSON.parse(localStorage.getItem('NXMO_user_data')).token);
      }
    }
  }

  /**
   * Get the username the for the stored token
   * @returns {string} the username to whom the token belongs to, empty string if none is set
   * @static
  */
  static getUsername() {
    if (!localStorage.getItem('NXMO_user_data')) {
      return Promise.resolve('');
    } else {
      return Promise.resolve(JSON.parse(localStorage.getItem('NXMO_user_data')).username);
    }
  }

  /**
   * Set or update the user token, includes the username and the token to be stored in
   * local storage
   *
   * @param {object} user_data the object holding the token and username
   * @param {string} user_data.username the username the token belongs to
   * @param {string} user_data.token the token to persist
   * @static
  */
  static updateToken(user_data) {
    if ((typeof (Storage) === 'undefined')) {
      return Promise.reject(new NexmoClientError('Storage not supported'));
    } else {
      Utils.getUsername().then((username) => {
        if (username === user_data.username || username === '') {
          localStorage.setItem('NXMO_user_data', JSON.stringify(user_data));
          return Promise.resolve();
        } else {
          return Promise.reject(new NexmoClientError('error:user:inconsistent-user'));
        }
      });
    }
  }

  /**
   * Clean up the token from LocalStorage
   * @static
  */
  static cleanupToken() {
    if (typeof (Storage) !== 'undefined') {
      localStorage.removeItem('NXMO_user_data');
    }
  }

  /**
   * Inject a script into the document
   *
   * @param {string} s script being executed
   * @param {requestCallback} c the callback fired after script executed
   * @static
  */
  static injectScript(u, c) {
    if (typeof document !== 'undefined') {
      let h = document.getElementsByTagName('head')[0];
      let s = document.createElement('script');
      s.async = true;
      s.src = u;
      s.onload = s.onreadystatechange = function() {
        if (!s.readyState || /loaded|complete/.test(s.readyState)) {
          s.onload = s.onreadystatechange = null;
          s = null;
          if (c) {
            c();
          }
        }
      };
      h.insertBefore(s, h.firstChild);
    }
  }

  static allocateUUID() {
    return uuid.v4();
  }

  /**
    * Validate dtmf digit
    * @static
  */
  static validateDTMF(digit) {
    return (typeof (digit) === 'string' && /^[\da-dA-D#*pP]{1,45}$$/.test(digit));
  }

  /**
    * Get the nexmo bugsnag api key
    * @private
  */
  static _getBugsnagKey() {
    return '76498fc1ca8d9b0a173a44e2b873d7ed';
  }

  /**
   * Update the member legs array with the new one received in the event
   *
   * @param {Array} legs the member legs array
   * @param {NXMEvent} event the member event holding the new legs array
   * @static
  */
  static updateMemberLegs(legs, event) {
    if (legs) {
      // find the leg in the legs array if exists
      const leg = legs.find((leg) => leg.leg_id === event.body.leg_id);

      if (!leg) {
        legs.push({
          leg_id: event.body.leg_id,
          status: event.body.status
        });
      } else if (leg.status !== event.body.status) {
        // if the status of the leg is different from the event status
        // update the leg object with the new leg status
        let index = legs.indexOf(leg);
        legs.fill(leg.status = event.body.status, index, index++);
      }
    } else {
      legs = [
        {
          leg_id: event.body.leg_id,
          status: event.body.status
        }
      ];
    }

    return legs;
  }
}

module.exports = Utils;

},{"./nexmoClientError":20,"uuid":80}],29:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.bugsnag = f()}})(function(){var define,module,exports;
// minimal implementations of useful ES functionality
// all we really need for arrays is reduce – everything else is just sugar!
// Array#reduce
var reduce = function (arr, fn, accum) {
  var val = accum;

  for (var i = 0, len = arr.length; i < len; i++) {
    val = fn(val, arr[i], i, arr);
  }

  return val;
}; // Array#filter


var filter = function (arr, fn) {
  return reduce(arr, function (accum, item, i, arr) {
    return !fn(item, i, arr) ? accum : accum.concat(item);
  }, []);
}; // Array#map


var map = function (arr, fn) {
  return reduce(arr, function (accum, item, i, arr) {
    return accum.concat(fn(item, i, arr));
  }, []);
}; // Array#includes


var includes = function (arr, x) {
  return reduce(arr, function (accum, item, i, arr) {
    return accum === true || item === x;
  }, false);
};

var _hasDontEnumBug = !{
  toString: null
}.propertyIsEnumerable('toString');

var _dontEnums = ['toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'constructor']; // Object#keys

var keys = function (obj) {
  // stripped down version of
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/Keys
  var result = [];
  var prop;

  for (prop in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) result.push(prop);
  }

  if (!_hasDontEnumBug) return result;

  for (var i = 0, len = _dontEnums.length; i < len; i++) {
    if (Object.prototype.hasOwnProperty.call(obj, _dontEnums[i])) result.push(_dontEnums[i]);
  }

  return result;
}; // Array#isArray


var isArray = function (obj) {
  return Object.prototype.toString.call(obj) === '[object Array]';
};

var _pad = function (n) {
  return n < 10 ? "0" + n : n;
}; // Date#toISOString


var isoDate = function () {
  // from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toISOString
  var d = new Date();
  return d.getUTCFullYear() + '-' + _pad(d.getUTCMonth() + 1) + '-' + _pad(d.getUTCDate()) + 'T' + _pad(d.getUTCHours()) + ':' + _pad(d.getUTCMinutes()) + ':' + _pad(d.getUTCSeconds()) + '.' + (d.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5) + 'Z';
};

var _$esUtils_8 = {
  map: map,
  reduce: reduce,
  filter: filter,
  includes: includes,
  keys: keys,
  isArray: isArray,
  isoDate: isoDate
};

var _$validators_14 = {};
_$validators_14.intRange = function (min, max) {
  if (min === void 0) {
    min = 1;
  }

  if (max === void 0) {
    max = Infinity;
  }

  return function (value) {
    return typeof value === 'number' && parseInt('' + value, 10) === value && value >= min && value <= max;
  };
};

_$validators_14.stringWithLength = function (value) {
  return typeof value === 'string' && !!value.length;
};

var _$config_5 = {};
var __filter_5 = _$esUtils_8.filter,
    __reduce_5 = _$esUtils_8.reduce,
    __keys_5 = _$esUtils_8.keys,
    __isArray_5 = _$esUtils_8.isArray,
    __includes_5 = _$esUtils_8.includes;

var intRange = _$validators_14.intRange,
    stringWithLength = _$validators_14.stringWithLength;

_$config_5.schema = {
  apiKey: {
    defaultValue: function () {
      return null;
    },
    message: 'is required',
    validate: stringWithLength
  },
  appVersion: {
    defaultValue: function () {
      return null;
    },
    message: 'should be a string',
    validate: function (value) {
      return value === null || stringWithLength(value);
    }
  },
  appType: {
    defaultValue: function () {
      return null;
    },
    message: 'should be a string',
    validate: function (value) {
      return value === null || stringWithLength(value);
    }
  },
  autoNotify: {
    defaultValue: function () {
      return true;
    },
    message: 'should be true|false',
    validate: function (value) {
      return value === true || value === false;
    }
  },
  beforeSend: {
    defaultValue: function () {
      return [];
    },
    message: 'should be a function or array of functions',
    validate: function (value) {
      return typeof value === 'function' || __isArray_5(value) && __filter_5(value, function (f) {
        return typeof f === 'function';
      }).length === value.length;
    }
  },
  endpoints: {
    defaultValue: function () {
      return {
        notify: 'https://notify.bugsnag.com',
        sessions: 'https://sessions.bugsnag.com'
      };
    },
    message: 'should be an object containing endpoint URLs { notify, sessions }. sessions is optional if autoCaptureSessions=false',
    validate: function (val, obj) {
      return (// first, ensure it's an object
        val && typeof val === 'object' && // endpoints.notify must always be set
        stringWithLength(val.notify) && ( // endpoints.sessions must be set unless session tracking is explicitly off
        obj.autoCaptureSessions === false || stringWithLength(val.sessions)) && // ensure no keys other than notify/session are set on endpoints object
        __filter_5(__keys_5(val), function (k) {
          return !__includes_5(['notify', 'sessions'], k);
        }).length === 0
      );
    }
  },
  autoCaptureSessions: {
    defaultValue: function (val, opts) {
      return opts.endpoints === undefined || !!opts.endpoints && !!opts.endpoints.sessions;
    },
    message: 'should be true|false',
    validate: function (val) {
      return val === true || val === false;
    }
  },
  notifyReleaseStages: {
    defaultValue: function () {
      return null;
    },
    message: 'should be an array of strings',
    validate: function (value) {
      return value === null || __isArray_5(value) && __filter_5(value, function (f) {
        return typeof f === 'string';
      }).length === value.length;
    }
  },
  releaseStage: {
    defaultValue: function () {
      return 'production';
    },
    message: 'should be a string',
    validate: function (value) {
      return typeof value === 'string' && value.length;
    }
  },
  maxBreadcrumbs: {
    defaultValue: function () {
      return 20;
    },
    message: 'should be a number ≤40',
    validate: function (value) {
      return intRange(0, 40)(value);
    }
  },
  autoBreadcrumbs: {
    defaultValue: function () {
      return true;
    },
    message: 'should be true|false',
    validate: function (value) {
      return typeof value === 'boolean';
    }
  },
  user: {
    defaultValue: function () {
      return null;
    },
    message: '(object) user should be an object',
    validate: function (value) {
      return typeof value === 'object';
    }
  },
  metaData: {
    defaultValue: function () {
      return null;
    },
    message: 'should be an object',
    validate: function (value) {
      return typeof value === 'object';
    }
  },
  logger: {
    defaultValue: function () {
      return undefined;
    },
    message: 'should be null or an object with methods { debug, info, warn, error }',
    validate: function (value) {
      return !value || value && __reduce_5(['debug', 'info', 'warn', 'error'], function (accum, method) {
        return accum && typeof value[method] === 'function';
      }, true);
    }
  },
  filters: {
    defaultValue: function () {
      return ['password'];
    },
    message: 'should be an array of strings|regexes',
    validate: function (value) {
      return __isArray_5(value) && value.length === __filter_5(value, function (s) {
        return typeof s === 'string' || s && typeof s.test === 'function';
      }).length;
    }
  }
};

_$config_5.mergeDefaults = function (opts, schema) {
  if (!opts || !schema) throw new Error('opts and schema objects are required');
  return __reduce_5(__keys_5(schema), function (accum, key) {
    accum[key] = opts[key] !== undefined ? opts[key] : schema[key].defaultValue(opts[key], opts);
    return accum;
  }, {});
};

_$config_5.validate = function (opts, schema) {
  if (!opts || !schema) throw new Error('opts and schema objects are required');
  var errors = __reduce_5(__keys_5(schema), function (accum, key) {
    if (schema[key].validate(opts[key], opts)) return accum;
    return accum.concat({
      key: key,
      message: schema[key].message,
      value: opts[key]
    });
  }, []);
  return {
    valid: !errors.length,
    errors: errors
  };
};

function _extends() { _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }

var schema = _$config_5.schema;

var __map_1 = _$esUtils_8.map;

var __stringWithLength_1 = _$validators_14.stringWithLength;

var _$config_1 = {
  releaseStage: {
    defaultValue: function () {
      if (/^localhost(:\d+)?$/.test(window.location.host)) return 'development';
      return 'production';
    },
    message: 'should be set',
    validate: __stringWithLength_1
  },
  logger: _extends({}, schema.logger, {
    defaultValue: function () {
      return (// set logger based on browser capability
        typeof console !== 'undefined' && typeof console.debug === 'function' ? getPrefixedConsole() : undefined
      );
    }
  })
};

var getPrefixedConsole = function () {
  var logger = {};
  var consoleLog = console['log'];
  __map_1(['debug', 'info', 'warn', 'error'], function (method) {
    var consoleMethod = console[method];
    logger[method] = typeof consoleMethod === 'function' ? consoleMethod.bind(console, '[bugsnag]') : consoleLog.bind(console, '[bugsnag]');
  });
  return logger;
};

var __isoDate_3 = _$esUtils_8.isoDate;

var BugsnagBreadcrumb =
/*#__PURE__*/
function () {
  function BugsnagBreadcrumb(name, metaData, type, timestamp) {
    if (name === void 0) {
      name = '[anonymous]';
    }

    if (metaData === void 0) {
      metaData = {};
    }

    if (type === void 0) {
      type = 'manual';
    }

    if (timestamp === void 0) {
      timestamp = __isoDate_3();
    }

    this.type = type;
    this.name = name;
    this.metaData = metaData;
    this.timestamp = timestamp;
  }

  var _proto = BugsnagBreadcrumb.prototype;

  _proto.toJSON = function toJSON() {
    return {
      type: this.type,
      name: this.name,
      timestamp: this.timestamp,
      metaData: this.metaData
    };
  };

  return BugsnagBreadcrumb;
}();

var _$BugsnagBreadcrumb_3 = BugsnagBreadcrumb;

// This is a heavily modified/simplified version of
//   https://github.com/othiym23/async-some
//
// We can't use that because:
//   a) it inflates the bundle size to over 10kB
//   b) it depends on a module that uses Object.keys()
//      (which we can't use due to ie8 support)
// run the asynchronous test function (fn) over each item in the array (arr)
// in series until:
//   - fn(item, cb) => calls cb(null, true)
//   - or the end of the array is reached
// the callback (cb) will be passed true if any of the items resulted in a true
// callback, otherwise false
var _$asyncSome_6 = function (arr, fn, cb) {
  var length = arr.length;
  var index = 0;

  var next = function () {
    if (index >= length) return cb(null, false);
    fn(arr[index], function (err, result) {
      if (err) return cb(err, false);
      if (result === true) return cb(null, true);
      index++;
      next();
    });
  };

  next();
};

var _$inferReleaseStage_10 = function (client) {
  return client.app && typeof client.app.releaseStage === 'string' ? client.app.releaseStage : client.config.releaseStage;
};

/**
 * Expose `isError`.
 */
var _$isError_20 = isError;
/**
 * Test whether `value` is error object.
 *
 * @param {*} value
 * @returns {boolean}
 */

function isError(value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object Error]':
      return true;

    case '[object Exception]':
      return true;

    case '[object DOMException]':
      return true;

    default:
      return value instanceof Error;
  }
}

var _$iserror_11 = _$isError_20;

var _$runBeforeSend_13 = function (report, onError) {
  return function (fn, cb) {
    if (typeof fn !== 'function') return cb(null, false);

    try {
      // if function appears sync…
      if (fn.length !== 2) {
        var ret = fn(report); // check if it returned a "thenable" (promise)

        if (ret && typeof ret.then === 'function') {
          return ret.then( // resolve
          function (val) {
            return setTimeout(function () {
              return cb(null, shouldPreventSend(report, val));
            }, 0);
          }, // reject
          function (err) {
            setTimeout(function () {
              onError(err);
              return cb(null, false);
            });
          });
        }

        return cb(null, shouldPreventSend(report, ret));
      } // if function is async…


      fn(report, function (err, result) {
        if (err) {
          onError(err);
          return cb(null, false);
        }

        cb(null, shouldPreventSend(report, result));
      });
    } catch (e) {
      onError(e);
      cb(null, false);
    }
  };
};

var shouldPreventSend = function (report, value) {
  return report.isIgnored() || value === false;
};

var _$stackframe_22 = {};
(function (root, factory) {
  'use strict'; // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

  /* istanbul ignore next */

  if (typeof define === 'function' && define.amd) {
    define('stackframe', [], factory);
  } else if (typeof _$stackframe_22 === 'object') {
    _$stackframe_22 = factory();
  } else {
    root.StackFrame = factory();
  }
})(this, function () {
  'use strict';

  function _isNumber(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
  }

  function _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.substring(1);
  }

  function _getter(p) {
    return function () {
      return this[p];
    };
  }

  var booleanProps = ['isConstructor', 'isEval', 'isNative', 'isToplevel'];
  var numericProps = ['columnNumber', 'lineNumber'];
  var stringProps = ['fileName', 'functionName', 'source'];
  var arrayProps = ['args'];
  var props = booleanProps.concat(numericProps, stringProps, arrayProps);

  function StackFrame(obj) {
    if (obj instanceof Object) {
      for (var i = 0; i < props.length; i++) {
        if (obj.hasOwnProperty(props[i]) && obj[props[i]] !== undefined) {
          this['set' + _capitalize(props[i])](obj[props[i]]);
        }
      }
    }
  }

  StackFrame.prototype = {
    getArgs: function () {
      return this.args;
    },
    setArgs: function (v) {
      if (Object.prototype.toString.call(v) !== '[object Array]') {
        throw new TypeError('Args must be an Array');
      }

      this.args = v;
    },
    getEvalOrigin: function () {
      return this.evalOrigin;
    },
    setEvalOrigin: function (v) {
      if (v instanceof StackFrame) {
        this.evalOrigin = v;
      } else if (v instanceof Object) {
        this.evalOrigin = new StackFrame(v);
      } else {
        throw new TypeError('Eval Origin must be an Object or StackFrame');
      }
    },
    toString: function () {
      var functionName = this.getFunctionName() || '{anonymous}';
      var args = '(' + (this.getArgs() || []).join(',') + ')';
      var fileName = this.getFileName() ? '@' + this.getFileName() : '';
      var lineNumber = _isNumber(this.getLineNumber()) ? ':' + this.getLineNumber() : '';
      var columnNumber = _isNumber(this.getColumnNumber()) ? ':' + this.getColumnNumber() : '';
      return functionName + args + fileName + lineNumber + columnNumber;
    }
  };

  for (var i = 0; i < booleanProps.length; i++) {
    StackFrame.prototype['get' + _capitalize(booleanProps[i])] = _getter(booleanProps[i]);

    StackFrame.prototype['set' + _capitalize(booleanProps[i])] = function (p) {
      return function (v) {
        this[p] = Boolean(v);
      };
    }(booleanProps[i]);
  }

  for (var j = 0; j < numericProps.length; j++) {
    StackFrame.prototype['get' + _capitalize(numericProps[j])] = _getter(numericProps[j]);

    StackFrame.prototype['set' + _capitalize(numericProps[j])] = function (p) {
      return function (v) {
        if (!_isNumber(v)) {
          throw new TypeError(p + ' must be a Number');
        }

        this[p] = Number(v);
      };
    }(numericProps[j]);
  }

  for (var k = 0; k < stringProps.length; k++) {
    StackFrame.prototype['get' + _capitalize(stringProps[k])] = _getter(stringProps[k]);

    StackFrame.prototype['set' + _capitalize(stringProps[k])] = function (p) {
      return function (v) {
        this[p] = String(v);
      };
    }(stringProps[k]);
  }

  return StackFrame;
});

var _$errorStackParser_19 = {};
(function (root, factory) {
  'use strict'; // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

  /* istanbul ignore next */

  if (typeof define === 'function' && define.amd) {
    define('error-stack-parser', ['stackframe'], factory);
  } else if (typeof _$errorStackParser_19 === 'object') {
    _$errorStackParser_19 = factory(_$stackframe_22);
  } else {
    root.ErrorStackParser = factory(root.StackFrame);
  }
})(this, function ErrorStackParser(StackFrame) {
  'use strict';

  var FIREFOX_SAFARI_STACK_REGEXP = /(^|@)\S+\:\d+/;
  var CHROME_IE_STACK_REGEXP = /^\s*at .*(\S+\:\d+|\(native\))/m;
  var SAFARI_NATIVE_CODE_REGEXP = /^(eval@)?(\[native code\])?$/;
  return {
    /**
     * Given an Error object, extract the most information from it.
     *
     * @param {Error} error object
     * @return {Array} of StackFrames
     */
    parse: function ErrorStackParser$$parse(error) {
      if (typeof error.stacktrace !== 'undefined' || typeof error['opera#sourceloc'] !== 'undefined') {
        return this.parseOpera(error);
      } else if (error.stack && error.stack.match(CHROME_IE_STACK_REGEXP)) {
        return this.parseV8OrIE(error);
      } else if (error.stack) {
        return this.parseFFOrSafari(error);
      } else {
        throw new Error('Cannot parse given Error object');
      }
    },
    // Separate line and column numbers from a string of the form: (URI:Line:Column)
    extractLocation: function ErrorStackParser$$extractLocation(urlLike) {
      // Fail-fast but return locations like "(native)"
      if (urlLike.indexOf(':') === -1) {
        return [urlLike];
      }

      var regExp = /(.+?)(?:\:(\d+))?(?:\:(\d+))?$/;
      var parts = regExp.exec(urlLike.replace(/[\(\)]/g, ''));
      return [parts[1], parts[2] || undefined, parts[3] || undefined];
    },
    parseV8OrIE: function ErrorStackParser$$parseV8OrIE(error) {
      var filtered = error.stack.split('\n').filter(function (line) {
        return !!line.match(CHROME_IE_STACK_REGEXP);
      }, this);
      return filtered.map(function (line) {
        if (line.indexOf('(eval ') > -1) {
          // Throw away eval information until we implement stacktrace.js/stackframe#8
          line = line.replace(/eval code/g, 'eval').replace(/(\(eval at [^\()]*)|(\)\,.*$)/g, '');
        }

        var tokens = line.replace(/^\s+/, '').replace(/\(eval code/g, '(').split(/\s+/).slice(1);
        var locationParts = this.extractLocation(tokens.pop());
        var functionName = tokens.join(' ') || undefined;
        var fileName = ['eval', '<anonymous>'].indexOf(locationParts[0]) > -1 ? undefined : locationParts[0];
        return new StackFrame({
          functionName: functionName,
          fileName: fileName,
          lineNumber: locationParts[1],
          columnNumber: locationParts[2],
          source: line
        });
      }, this);
    },
    parseFFOrSafari: function ErrorStackParser$$parseFFOrSafari(error) {
      var filtered = error.stack.split('\n').filter(function (line) {
        return !line.match(SAFARI_NATIVE_CODE_REGEXP);
      }, this);
      return filtered.map(function (line) {
        // Throw away eval information until we implement stacktrace.js/stackframe#8
        if (line.indexOf(' > eval') > -1) {
          line = line.replace(/ line (\d+)(?: > eval line \d+)* > eval\:\d+\:\d+/g, ':$1');
        }

        if (line.indexOf('@') === -1 && line.indexOf(':') === -1) {
          // Safari eval frames only have function names and nothing else
          return new StackFrame({
            functionName: line
          });
        } else {
          var functionNameRegex = /((.*".+"[^@]*)?[^@]*)(?:@)/;
          var matches = line.match(functionNameRegex);
          var functionName = matches && matches[1] ? matches[1] : undefined;
          var locationParts = this.extractLocation(line.replace(functionNameRegex, ''));
          return new StackFrame({
            functionName: functionName,
            fileName: locationParts[0],
            lineNumber: locationParts[1],
            columnNumber: locationParts[2],
            source: line
          });
        }
      }, this);
    },
    parseOpera: function ErrorStackParser$$parseOpera(e) {
      if (!e.stacktrace || e.message.indexOf('\n') > -1 && e.message.split('\n').length > e.stacktrace.split('\n').length) {
        return this.parseOpera9(e);
      } else if (!e.stack) {
        return this.parseOpera10(e);
      } else {
        return this.parseOpera11(e);
      }
    },
    parseOpera9: function ErrorStackParser$$parseOpera9(e) {
      var lineRE = /Line (\d+).*script (?:in )?(\S+)/i;
      var lines = e.message.split('\n');
      var result = [];

      for (var i = 2, len = lines.length; i < len; i += 2) {
        var match = lineRE.exec(lines[i]);

        if (match) {
          result.push(new StackFrame({
            fileName: match[2],
            lineNumber: match[1],
            source: lines[i]
          }));
        }
      }

      return result;
    },
    parseOpera10: function ErrorStackParser$$parseOpera10(e) {
      var lineRE = /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i;
      var lines = e.stacktrace.split('\n');
      var result = [];

      for (var i = 0, len = lines.length; i < len; i += 2) {
        var match = lineRE.exec(lines[i]);

        if (match) {
          result.push(new StackFrame({
            functionName: match[3] || undefined,
            fileName: match[2],
            lineNumber: match[1],
            source: lines[i]
          }));
        }
      }

      return result;
    },
    // Opera 10.65+ Error.stack very similar to FF/Safari
    parseOpera11: function ErrorStackParser$$parseOpera11(error) {
      var filtered = error.stack.split('\n').filter(function (line) {
        return !!line.match(FIREFOX_SAFARI_STACK_REGEXP) && !line.match(/^Error created at/);
      }, this);
      return filtered.map(function (line) {
        var tokens = line.split('@');
        var locationParts = this.extractLocation(tokens.pop());
        var functionCall = tokens.shift() || '';
        var functionName = functionCall.replace(/<anonymous function(: (\w+))?>/, '$2').replace(/\([^\)]*\)/g, '') || undefined;
        var argsRaw;

        if (functionCall.match(/\(([^\)]*)\)/)) {
          argsRaw = functionCall.replace(/^[^\(]+\(([^\)]*)\)$/, '$1');
        }

        var args = argsRaw === undefined || argsRaw === '[arguments not available]' ? undefined : argsRaw.split(',');
        return new StackFrame({
          functionName: functionName,
          args: args,
          fileName: locationParts[0],
          lineNumber: locationParts[1],
          columnNumber: locationParts[2],
          source: line
        });
      }, this);
    }
  };
});

var _$errorStackParser_7 = _$errorStackParser_19;

// Given `err` which may be an error, does it have a stack property which is a string?
var _$hasStack_9 = function (err) {
  return !!err && (!!err.stack || !!err.stacktrace || !!err['opera#sourceloc']) && typeof (err.stack || err.stacktrace || err['opera#sourceloc']) === 'string' && err.stack !== err.name + ": " + err.message;
};

var _$stackGenerator_21 = {};
(function (root, factory) {
  'use strict'; // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

  /* istanbul ignore next */

  if (typeof define === 'function' && define.amd) {
    define('stack-generator', ['stackframe'], factory);
  } else if (typeof _$stackGenerator_21 === 'object') {
    _$stackGenerator_21 = factory(_$stackframe_22);
  } else {
    root.StackGenerator = factory(root.StackFrame);
  }
})(this, function (StackFrame) {
  return {
    backtrace: function StackGenerator$$backtrace(opts) {
      var stack = [];
      var maxStackSize = 10;

      if (typeof opts === 'object' && typeof opts.maxStackSize === 'number') {
        maxStackSize = opts.maxStackSize;
      }

      var curr = arguments.callee;

      while (curr && stack.length < maxStackSize && curr['arguments']) {
        // Allow V8 optimizations
        var args = new Array(curr['arguments'].length);

        for (var i = 0; i < args.length; ++i) {
          args[i] = curr['arguments'][i];
        }

        if (/function(?:\s+([\w$]+))+\s*\(/.test(curr.toString())) {
          stack.push(new StackFrame({
            functionName: RegExp.$1 || undefined,
            args: args
          }));
        } else {
          stack.push(new StackFrame({
            args: args
          }));
        }

        try {
          curr = curr.caller;
        } catch (e) {
          break;
        }
      }

      return stack;
    }
  };
});

function ___extends_23() { ___extends_23 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_23.apply(this, arguments); }

/* removed: var _$errorStackParser_7 = require('./lib/error-stack-parser'); */;

/* removed: var _$stackGenerator_21 = require('stack-generator'); */;

/* removed: var _$hasStack_9 = require('./lib/has-stack'); */;

var __reduce_23 = _$esUtils_8.reduce,
    __filter_23 = _$esUtils_8.filter;

var BugsnagReport =
/*#__PURE__*/
function () {
  function BugsnagReport(errorClass, errorMessage, stacktrace, handledState, originalError) {
    if (stacktrace === void 0) {
      stacktrace = [];
    }

    if (handledState === void 0) {
      handledState = defaultHandledState();
    }

    // duck-typing ftw >_<
    this.__isBugsnagReport = true;
    this._ignored = false; // private (un)handled state

    this._handledState = handledState; // setable props

    this.app = undefined;
    this.apiKey = undefined;
    this.breadcrumbs = [];
    this.context = undefined;
    this.device = undefined;
    this.errorClass = stringOrFallback(errorClass, '[no error class]');
    this.errorMessage = stringOrFallback(errorMessage, '[no error message]');
    this.groupingHash = undefined;
    this.metaData = {};
    this.request = undefined;
    this.severity = this._handledState.severity;
    this.stacktrace = __reduce_23(stacktrace, function (accum, frame) {
      var f = formatStackframe(frame); // don't include a stackframe if none of its properties are defined

      try {
        if (JSON.stringify(f) === '{}') return accum;
        return accum.concat(f);
      } catch (e) {
        return accum;
      }
    }, []);
    this.user = undefined;
    this.session = undefined;
    this.originalError = originalError;
  }

  var _proto = BugsnagReport.prototype;

  _proto.ignore = function ignore() {
    this._ignored = true;
  };

  _proto.isIgnored = function isIgnored() {
    return this._ignored;
  };

  _proto.updateMetaData = function updateMetaData(section) {
    var _updates;

    if (!section) return this;
    var updates; // updateMetaData("section", null) -> removes section

    if ((arguments.length <= 1 ? undefined : arguments[1]) === null) return this.removeMetaData(section); // updateMetaData("section", "property", null) -> removes property from section

    if ((arguments.length <= 2 ? undefined : arguments[2]) === null) return this.removeMetaData(section, arguments.length <= 1 ? undefined : arguments[1], arguments.length <= 2 ? undefined : arguments[2]); // normalise the two supported input types into object form

    if (typeof (arguments.length <= 1 ? undefined : arguments[1]) === 'object') updates = arguments.length <= 1 ? undefined : arguments[1];
    if (typeof (arguments.length <= 1 ? undefined : arguments[1]) === 'string') updates = (_updates = {}, _updates[arguments.length <= 1 ? undefined : arguments[1]] = arguments.length <= 2 ? undefined : arguments[2], _updates); // exit if we don't have an updates object at this point

    if (!updates) return this; // ensure a section with this name exists

    if (!this.metaData[section]) this.metaData[section] = {}; // merge the updates with the existing section

    this.metaData[section] = ___extends_23({}, this.metaData[section], updates);
    return this;
  };

  _proto.removeMetaData = function removeMetaData(section, property) {
    if (typeof section !== 'string') return this; // remove an entire section

    if (!property) {
      delete this.metaData[section];
      return this;
    } // remove a single property from a section


    if (this.metaData[section]) {
      delete this.metaData[section][property];
      return this;
    }

    return this;
  };

  _proto.toJSON = function toJSON() {
    return {
      payloadVersion: '4',
      exceptions: [{
        errorClass: this.errorClass,
        message: this.errorMessage,
        stacktrace: this.stacktrace,
        type: "yes" ? 'browserjs' : 'nodejs'
      }],
      severity: this.severity,
      unhandled: this._handledState.unhandled,
      severityReason: this._handledState.severityReason,
      app: this.app,
      device: this.device,
      breadcrumbs: this.breadcrumbs,
      context: this.context,
      user: this.user,
      metaData: this.metaData,
      groupingHash: this.groupingHash,
      request: this.request,
      session: this.session
    };
  };

  return BugsnagReport;
}(); // takes a stacktrace.js style stackframe (https://github.com/stacktracejs/stackframe)
// and returns a Bugsnag compatible stackframe (https://docs.bugsnag.com/api/error-reporting/#json-payload)


var formatStackframe = function (frame) {
  var f = {
    file: frame.fileName,
    method: normaliseFunctionName(frame.functionName),
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    code: undefined,
    inProject: undefined // Some instances result in no file:
    // - calling notify() from chrome's terminal results in no file/method.
    // - non-error exception thrown from global code in FF
    // This adds one.

  };

  if (f.lineNumber > -1 && !f.file && !f.method) {
    f.file = 'global code';
  }

  return f;
};

var normaliseFunctionName = function (name) {
  return /^global code$/i.test(name) ? 'global code' : name;
};

var defaultHandledState = function () {
  return {
    unhandled: false,
    severity: 'warning',
    severityReason: {
      type: 'handledException'
    }
  };
};

var stringOrFallback = function (str, fallback) {
  return typeof str === 'string' && str ? str : fallback;
}; // Helpers


BugsnagReport.getStacktrace = function (error, errorFramesToSkip, generatedFramesToSkip) {
  if (errorFramesToSkip === void 0) {
    errorFramesToSkip = 0;
  }

  if (generatedFramesToSkip === void 0) {
    generatedFramesToSkip = 0;
  }

  if (_$hasStack_9(error)) return _$errorStackParser_7.parse(error).slice(errorFramesToSkip); // error wasn't provided or didn't have a stacktrace so try to walk the callstack

  return __filter_23(_$stackGenerator_21.backtrace(), function (frame) {
    return (frame.functionName || '').indexOf('StackGenerator$$') === -1;
  }).slice(1 + generatedFramesToSkip);
};

BugsnagReport.ensureReport = function (reportOrError, errorFramesToSkip, generatedFramesToSkip) {
  if (errorFramesToSkip === void 0) {
    errorFramesToSkip = 0;
  }

  if (generatedFramesToSkip === void 0) {
    generatedFramesToSkip = 0;
  }

  // notify() can be called with a Report object. In this case no action is required
  if (reportOrError.__isBugsnagReport) return reportOrError;

  try {
    var stacktrace = BugsnagReport.getStacktrace(reportOrError, errorFramesToSkip, 1 + generatedFramesToSkip);
    return new BugsnagReport(reportOrError.name, reportOrError.message, stacktrace, undefined, reportOrError);
  } catch (e) {
    return new BugsnagReport(reportOrError.name, reportOrError.message, [], undefined, reportOrError);
  }
};

var _$BugsnagReport_23 = BugsnagReport;

var _$pad_17 = function pad(num, size) {
  var s = '000000000' + num;
  return s.substr(s.length - size);
};

/* removed: var _$pad_17 = require('./pad.js'); */;

var env = typeof window === 'object' ? window : self;
var globalCount = 0;

for (var prop in env) {
  if (Object.hasOwnProperty.call(env, prop)) globalCount++;
}

var mimeTypesLength = navigator.mimeTypes ? navigator.mimeTypes.length : 0;
var clientId = _$pad_17((mimeTypesLength + navigator.userAgent.length).toString(36) + globalCount.toString(36), 4);

var _$fingerprint_16 = function fingerprint() {
  return clientId;
};

/**
 * cuid.js
 * Collision-resistant UID generator for browsers and node.
 * Sequential for fast db lookups and recency sorting.
 * Safe for element IDs and server-side lookups.
 *
 * Extracted from CLCTR
 *
 * Copyright (c) Eric Elliott 2012
 * MIT License
 */
/* removed: var _$fingerprint_16 = require('./lib/fingerprint.js'); */;

/* removed: var _$pad_17 = require('./lib/pad.js'); */;

var c = 0,
    blockSize = 4,
    base = 36,
    discreteValues = Math.pow(base, blockSize);

function randomBlock() {
  return _$pad_17((Math.random() * discreteValues << 0).toString(base), blockSize);
}

function safeCounter() {
  c = c < discreteValues ? c : 0;
  c++; // this is not subliminal

  return c - 1;
}

function cuid() {
  // Starting with a lowercase letter makes
  // it HTML element ID friendly.
  var letter = 'c',
      // hard-coded allows for sequential access
  // timestamp
  // warning: this exposes the exact date and time
  // that the uid was created.
  timestamp = new Date().getTime().toString(base),
      // Prevent same-machine collisions.
  counter = _$pad_17(safeCounter().toString(base), blockSize),
      // A few chars to generate distinct ids for different
  // clients (so different computers are far less
  // likely to generate the same id)
  print = _$fingerprint_16(),
      // Grab some more chars from Math.random()
  random = randomBlock() + randomBlock();
  return letter + timestamp + counter + print + random;
}

cuid.fingerprint = _$fingerprint_16;
var _$cuid_15 = cuid;

var __isoDate_24 = _$esUtils_8.isoDate;

/* removed: var _$cuid_15 = require('@bugsnag/cuid'); */;

var Session =
/*#__PURE__*/
function () {
  function Session() {
    this.id = _$cuid_15();
    this.startedAt = __isoDate_24();
    this._handled = 0;
    this._unhandled = 0;
  }

  var _proto = Session.prototype;

  _proto.toJSON = function toJSON() {
    return {
      id: this.id,
      startedAt: this.startedAt,
      events: {
        handled: this._handled,
        unhandled: this._unhandled
      }
    };
  };

  _proto.trackError = function trackError(report) {
    this[report._handledState.unhandled ? '_unhandled' : '_handled'] += 1;
  };

  return Session;
}();

var _$Session_24 = Session;

function ___extends_4() { ___extends_4 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_4.apply(this, arguments); }

/* removed: var _$config_5 = require('./config'); */;

/* removed: var _$BugsnagReport_23 = require('./report'); */;

/* removed: var _$BugsnagBreadcrumb_3 = require('./breadcrumb'); */;

/* removed: var _$Session_24 = require('./session'); */;

var __map_4 = _$esUtils_8.map,
    __includes_4 = _$esUtils_8.includes,
    __isArray_4 = _$esUtils_8.isArray;

/* removed: var _$inferReleaseStage_10 = require('./lib/infer-release-stage'); */;

/* removed: var _$iserror_11 = require('./lib/iserror'); */;

/* removed: var _$asyncSome_6 = require('./lib/async-some'); */;

/* removed: var _$runBeforeSend_13 = require('./lib/run-before-send'); */;

var LOG_USAGE_ERR_PREFIX = "Usage error.";
var REPORT_USAGE_ERR_PREFIX = "Bugsnag usage error.";

var BugsnagClient =
/*#__PURE__*/
function () {
  function BugsnagClient(notifier) {
    if (!notifier || !notifier.name || !notifier.version || !notifier.url) {
      throw new Error('`notifier` argument is required');
    } // notifier id


    this.notifier = notifier; // configure() should be called before notify()

    this._configured = false; // intialise opts and config

    this._opts = {};
    this.config = {}; // // i/o

    this._delivery = {
      sendSession: function () {},
      sendReport: function () {}
    };
    this._logger = {
      debug: function () {},
      info: function () {},
      warn: function () {},
      error: function () {} // plugins

    };
    this._plugins = {};
    this._session = null;
    this.breadcrumbs = []; // setable props

    this.app = {};
    this.context = undefined;
    this.device = undefined;
    this.metaData = undefined;
    this.request = undefined;
    this.user = {}; // expose internal constructors

    this.BugsnagClient = BugsnagClient;
    this.BugsnagReport = _$BugsnagReport_23;
    this.BugsnagBreadcrumb = _$BugsnagBreadcrumb_3;
    this.BugsnagSession = _$Session_24;
    var self = this;
    var notify = this.notify;

    this.notify = function () {
      return notify.apply(self, arguments);
    };
  }

  var _proto = BugsnagClient.prototype;

  _proto.setOptions = function setOptions(opts) {
    this._opts = ___extends_4({}, this._opts, opts);
  };

  _proto.configure = function configure(partialSchema) {
    if (partialSchema === void 0) {
      partialSchema = _$config_5.schema;
    }

    var conf = _$config_5.mergeDefaults(this._opts, partialSchema);
    var validity = _$config_5.validate(conf, partialSchema);
    if (!validity.valid === true) throw new Error(generateConfigErrorMessage(validity.errors)); // update and elevate some special options if they were passed in at this point

    if (typeof conf.beforeSend === 'function') conf.beforeSend = [conf.beforeSend];
    if (conf.appVersion) this.app.version = conf.appVersion;
    if (conf.appType) this.app.type = conf.appType;
    if (conf.metaData) this.metaData = conf.metaData;
    if (conf.user) this.user = conf.user;
    if (conf.logger) this.logger(conf.logger); // merge with existing config

    this.config = ___extends_4({}, this.config, conf);
    this._configured = true;
    return this;
  };

  _proto.use = function use(plugin) {
    if (!this._configured) throw new Error('client not configured');
    if (plugin.configSchema) this.configure(plugin.configSchema);

    for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    var result = plugin.init.apply(plugin, [this].concat(args)); // JS objects are not the safest way to store arbitrarily keyed values,
    // so bookend the key with some characters that prevent tampering with
    // stuff like __proto__ etc. (only store the result if the plugin had a
    // name)

    if (plugin.name) this._plugins["~" + plugin.name + "~"] = result;
    return this;
  };

  _proto.getPlugin = function getPlugin(name) {
    return this._plugins["~" + name + "~"];
  };

  _proto.delivery = function delivery(d) {
    this._delivery = d;
    return this;
  };

  _proto.logger = function logger(l, sid) {
    this._logger = l;
    return this;
  };

  _proto.sessionDelegate = function sessionDelegate(s) {
    this._sessionDelegate = s;
    return this;
  };

  _proto.startSession = function startSession() {
    if (!this._sessionDelegate) {
      this._logger.warn('No session implementation is installed');

      return this;
    }

    return this._sessionDelegate.startSession(this);
  };

  _proto.leaveBreadcrumb = function leaveBreadcrumb(name, metaData, type, timestamp) {
    if (!this._configured) throw new Error('client not configured'); // coerce bad values so that the defaults get set

    name = name || undefined;
    type = typeof type === 'string' ? type : undefined;
    timestamp = typeof timestamp === 'string' ? timestamp : undefined;
    metaData = typeof metaData === 'object' && metaData !== null ? metaData : undefined; // if no name and no metaData, usefulness of this crumb is questionable at best so discard

    if (typeof name !== 'string' && !metaData) return;
    var crumb = new _$BugsnagBreadcrumb_3(name, metaData, type, timestamp); // push the valid crumb onto the queue and maintain the length

    this.breadcrumbs.push(crumb);

    if (this.breadcrumbs.length > this.config.maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(this.breadcrumbs.length - this.config.maxBreadcrumbs);
    }

    return this;
  };

  _proto.notify = function notify(error, opts, cb) {
    var _this = this;

    if (opts === void 0) {
      opts = {};
    }

    if (cb === void 0) {
      cb = function () {};
    }

    if (!this._configured) throw new Error('client not configured'); // releaseStage can be set via config.releaseStage or client.app.releaseStage

    var releaseStage = _$inferReleaseStage_10(this); // ensure we have an error (or a reasonable object representation of an error)

    var _normaliseError = normaliseError(error, opts, this._logger),
        err = _normaliseError.err,
        errorFramesToSkip = _normaliseError.errorFramesToSkip,
        _opts = _normaliseError._opts;

    if (_opts) opts = _opts; // ensure opts is an object

    if (typeof opts !== 'object' || opts === null) opts = {}; // create a report from the error, if it isn't one already

    var report = _$BugsnagReport_23.ensureReport(err, errorFramesToSkip, 2);
    report.app = ___extends_4({}, {
      releaseStage: releaseStage
    }, report.app, this.app);
    report.context = report.context || opts.context || this.context || undefined;
    report.device = ___extends_4({}, report.device, this.device, opts.device);
    report.request = ___extends_4({}, report.request, this.request, opts.request);
    report.user = ___extends_4({}, report.user, this.user, opts.user);
    report.metaData = ___extends_4({}, report.metaData, this.metaData, opts.metaData);
    report.breadcrumbs = this.breadcrumbs.slice(0);

    if (this._session) {
      this._session.trackError(report);

      report.session = this._session;
    } // set severity if supplied


    if (opts.severity !== undefined) {
      report.severity = opts.severity;
      report._handledState.severityReason = {
        type: 'userSpecifiedSeverity'
      };
    } // exit early if the reports should not be sent on the current releaseStage


    if (__isArray_4(this.config.notifyReleaseStages) && !__includes_4(this.config.notifyReleaseStages, releaseStage)) {
      this._logger.warn("Report not sent due to releaseStage/notifyReleaseStages configuration");

      return cb(null, report);
    }

    var originalSeverity = report.severity;
    var beforeSend = [].concat(opts.beforeSend).concat(this.config.beforeSend);

    var onBeforeSendErr = function (err) {
      _this._logger.error("Error occurred in beforeSend callback, continuing anyway\u2026");

      _this._logger.error(err);
    };

    _$asyncSome_6(beforeSend, _$runBeforeSend_13(report, onBeforeSendErr), function (err, preventSend) {
      if (err) onBeforeSendErr(err);

      if (preventSend) {
        _this._logger.debug("Report not sent due to beforeSend callback");

        return cb(null, report);
      } // only leave a crumb for the error if actually got sent


      if (_this.config.autoBreadcrumbs) {
        _this.leaveBreadcrumb(report.errorClass, {
          errorClass: report.errorClass,
          errorMessage: report.errorMessage,
          severity: report.severity
        }, 'error');
      }

      if (originalSeverity !== report.severity) {
        report._handledState.severityReason = {
          type: 'userCallbackSetSeverity'
        };
      }

      _this._delivery.sendReport(_this._logger, _this.config, {
        apiKey: report.apiKey || _this.config.apiKey,
        notifier: _this.notifier,
        events: [report]
      }, function (err) {
        return cb(err, report);
      });
    });
  };

  return BugsnagClient;
}();

var normaliseError = function (error, opts, logger) {
  var synthesizedErrorFramesToSkip = 3;

  var createAndLogUsageError = function (reason) {
    var msg = generateNotifyUsageMessage(reason);
    logger.warn(LOG_USAGE_ERR_PREFIX + " " + msg);
    return new Error(REPORT_USAGE_ERR_PREFIX + " " + msg);
  };

  var err;
  var errorFramesToSkip = 0;

  var _opts;

  switch (typeof error) {
    case 'string':
      if (typeof opts === 'string') {
        // ≤v3 used to have a notify('ErrorName', 'Error message') interface
        // report usage/deprecation errors if this function is called like that
        err = createAndLogUsageError('string/string');
        _opts = {
          metaData: {
            notifier: {
              notifyArgs: [error, opts]
            }
          }
        };
      } else {
        err = new Error(String(error));
        errorFramesToSkip = synthesizedErrorFramesToSkip;
      }

      break;

    case 'number':
    case 'boolean':
      err = new Error(String(error));
      break;

    case 'function':
      err = createAndLogUsageError('function');
      break;

    case 'object':
      if (error !== null && (_$iserror_11(error) || error.__isBugsnagReport)) {
        err = error;
      } else if (error !== null && hasNecessaryFields(error)) {
        err = new Error(error.message || error.errorMessage);
        err.name = error.name || error.errorClass;
        errorFramesToSkip = synthesizedErrorFramesToSkip;
      } else {
        err = createAndLogUsageError(error === null ? 'null' : 'unsupported object');
      }

      break;

    default:
      err = createAndLogUsageError('nothing');
  }

  return {
    err: err,
    errorFramesToSkip: errorFramesToSkip,
    _opts: _opts
  };
};

var hasNecessaryFields = function (error) {
  return (typeof error.name === 'string' || typeof error.errorClass === 'string') && (typeof error.message === 'string' || typeof error.errorMessage === 'string');
};

var generateConfigErrorMessage = function (errors) {
  return "Bugsnag configuration error\n" + __map_4(errors, function (err) {
    return "\"" + err.key + "\" " + err.message + " \n    got " + stringify(err.value);
  }).join('\n\n');
};

var generateNotifyUsageMessage = function (actual) {
  return "notify() expected error/opts parameters, got " + actual;
};

var stringify = function (val) {
  return typeof val === 'object' ? JSON.stringify(val) : String(val);
};

var _$BugsnagClient_4 = BugsnagClient;

var _$safeJsonStringify_18 = function (data, replacer, space, opts) {
  var filterKeys = opts && opts.filterKeys ? opts.filterKeys : [];
  var filterPaths = opts && opts.filterPaths ? opts.filterPaths : [];
  return JSON.stringify(prepareObjForSerialization(data, filterKeys, filterPaths), replacer, space);
};

var MAX_DEPTH = 20;
var MAX_EDGES = 25000;
var MIN_PRESERVED_DEPTH = 8;
var REPLACEMENT_NODE = '...';

function __isError_18(o) {
  return o instanceof Error || /^\[object (Error|(Dom)?Exception)\]$/.test(Object.prototype.toString.call(o));
}

function throwsMessage(err) {
  return '[Throws: ' + (err ? err.message : '?') + ']';
}

function find(haystack, needle) {
  for (var i = 0, len = haystack.length; i < len; i++) {
    if (haystack[i] === needle) return true;
  }

  return false;
} // returns true if the string `path` starts with any of the provided `paths`


function isDescendent(paths, path) {
  for (var i = 0, len = paths.length; i < len; i++) {
    if (path.indexOf(paths[i]) === 0) return true;
  }

  return false;
}

function shouldFilter(patterns, key) {
  for (var i = 0, len = patterns.length; i < len; i++) {
    if (typeof patterns[i] === 'string' && patterns[i] === key) return true;
    if (patterns[i] && typeof patterns[i].test === 'function' && patterns[i].test(key)) return true;
  }

  return false;
}

function __isArray_18(obj) {
  return Object.prototype.toString.call(obj) === '[object Array]';
}

function safelyGetProp(obj, prop) {
  try {
    return obj[prop];
  } catch (err) {
    return throwsMessage(err);
  }
}

function prepareObjForSerialization(obj, filterKeys, filterPaths) {
  var seen = []; // store references to objects we have seen before

  var edges = 0;

  function visit(obj, path) {
    function edgesExceeded() {
      return path.length > MIN_PRESERVED_DEPTH && edges > MAX_EDGES;
    }

    edges++;
    if (path.length > MAX_DEPTH) return REPLACEMENT_NODE;
    if (edgesExceeded()) return REPLACEMENT_NODE;
    if (obj === null || typeof obj !== 'object') return obj;
    if (find(seen, obj)) return '[Circular]';
    seen.push(obj);

    if (typeof obj.toJSON === 'function') {
      try {
        // we're not going to count this as an edge because it
        // replaces the value of the currently visited object
        edges--;
        var fResult = visit(obj.toJSON(), path);
        seen.pop();
        return fResult;
      } catch (err) {
        return throwsMessage(err);
      }
    }

    var er = __isError_18(obj);

    if (er) {
      edges--;
      var eResult = visit({
        name: obj.name,
        message: obj.message
      }, path);
      seen.pop();
      return eResult;
    }

    if (__isArray_18(obj)) {
      var aResult = [];

      for (var i = 0, len = obj.length; i < len; i++) {
        if (edgesExceeded()) {
          aResult.push(REPLACEMENT_NODE);
          break;
        }

        aResult.push(visit(obj[i], path.concat('[]')));
      }

      seen.pop();
      return aResult;
    }

    var result = {};

    try {
      for (var prop in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, prop)) continue;

        if (isDescendent(filterPaths, path.join('.')) && shouldFilter(filterKeys, prop)) {
          result[prop] = '[Filtered]';
          continue;
        }

        if (edgesExceeded()) {
          result[prop] = REPLACEMENT_NODE;
          break;
        }

        result[prop] = visit(safelyGetProp(obj, prop), path.concat(prop));
      }
    } catch (e) {}

    seen.pop();
    return result;
  }

  return visit(obj, []);
}

var _$jsonPayload_12 = {};
/* removed: var _$safeJsonStringify_18 = require('@bugsnag/safe-json-stringify'); */;

var REPORT_FILTER_PATHS = ['events.[].app', 'events.[].metaData', 'events.[].user', 'events.[].breadcrumbs', 'events.[].request', 'events.[].device'];
var SESSION_FILTER_PATHS = ['device', 'app', 'user'];

_$jsonPayload_12.report = function (report, filterKeys) {
  var payload = _$safeJsonStringify_18(report, null, null, {
    filterPaths: REPORT_FILTER_PATHS,
    filterKeys: filterKeys
  });

  if (payload.length > 10e5) {
    delete report.events[0].metaData;
    report.events[0].metaData = {
      notifier: "WARNING!\nSerialized payload was " + payload.length / 10e5 + "MB (limit = 1MB)\nmetaData was removed"
    };
    payload = _$safeJsonStringify_18(report, null, null, {
      filterPaths: REPORT_FILTER_PATHS,
      filterKeys: filterKeys
    });
    if (payload.length > 10e5) throw new Error('payload exceeded 1MB limit');
  }

  return payload;
};

_$jsonPayload_12.session = function (report, filterKeys) {
  var payload = _$safeJsonStringify_18(report, null, null, {
    filterPaths: SESSION_FILTER_PATHS,
    filterKeys: filterKeys
  });
  if (payload.length > 10e5) throw new Error('payload exceeded 1MB limit');
  return payload;
};

var _$delivery_25 = {};
/* removed: var _$jsonPayload_12 = require('@bugsnag/core/lib/json-payload'); */;

var __isoDate_25 = _$esUtils_8.isoDate;

_$delivery_25 = function (win) {
  if (win === void 0) {
    win = window;
  }

  return {
    sendReport: function (logger, config, report, cb) {
      if (cb === void 0) {
        cb = function () {};
      }

      var url = getApiUrl(config, 'notify', '4', win);
      var req = new win.XDomainRequest();

      req.onload = function () {
        cb(null);
      };

      req.open('POST', url);
      setTimeout(function () {
        try {
          req.send(_$jsonPayload_12.report(report, config.filters));
        } catch (e) {
          logger.error(e);
          cb(e);
        }
      }, 0);
    },
    sendSession: function (logger, config, session, cb) {
      if (cb === void 0) {
        cb = function () {};
      }

      var url = getApiUrl(config, 'sessions', '1', win);
      var req = new win.XDomainRequest();

      req.onload = function () {
        cb(null);
      };

      req.open('POST', url);
      setTimeout(function () {
        try {
          req.send(_$jsonPayload_12.session(session, config.filters));
        } catch (e) {
          logger.error(e);
          cb(e);
        }
      }, 0);
    }
  };
};

var getApiUrl = function (config, endpoint, version, win) {
  return matchPageProtocol(config.endpoints[endpoint], win.location.protocol) + "?apiKey=" + encodeURIComponent(config.apiKey) + "&payloadVersion=" + version + "&sentAt=" + encodeURIComponent(__isoDate_25());
};

var matchPageProtocol = _$delivery_25._matchPageProtocol = function (endpoint, pageProtocol) {
  return pageProtocol === 'http:' ? endpoint.replace(/^https:/, 'http:') : endpoint;
};

/* removed: var _$jsonPayload_12 = require('@bugsnag/core/lib/json-payload'); */;

var __isoDate_26 = _$esUtils_8.isoDate;

var _$delivery_26 = function (win) {
  if (win === void 0) {
    win = window;
  }

  return {
    sendReport: function (logger, config, report, cb) {
      if (cb === void 0) {
        cb = function () {};
      }

      try {
        var url = config.endpoints.notify;
        var req = new win.XMLHttpRequest();

        req.onreadystatechange = function () {
          if (req.readyState === win.XMLHttpRequest.DONE) cb(null);
        };

        req.open('POST', url);
        req.setRequestHeader('Content-Type', 'application/json');
        req.setRequestHeader('Bugsnag-Api-Key', report.apiKey || config.apiKey);
        req.setRequestHeader('Bugsnag-Payload-Version', '4');
        req.setRequestHeader('Bugsnag-Sent-At', __isoDate_26());
        req.send(_$jsonPayload_12.report(report, config.filters));
      } catch (e) {
        logger.error(e);
      }
    },
    sendSession: function (logger, config, session, cb) {
      if (cb === void 0) {
        cb = function () {};
      }

      try {
        var url = config.endpoints.sessions;
        var req = new win.XMLHttpRequest();

        req.onreadystatechange = function () {
          if (req.readyState === win.XMLHttpRequest.DONE) cb(null);
        };

        req.open('POST', url);
        req.setRequestHeader('Content-Type', 'application/json');
        req.setRequestHeader('Bugsnag-Api-Key', config.apiKey);
        req.setRequestHeader('Bugsnag-Payload-Version', '1');
        req.setRequestHeader('Bugsnag-Sent-At', __isoDate_26());
        req.send(_$jsonPayload_12.session(session, config.filters));
      } catch (e) {
        logger.error(e);
      }
    }
  };
};

/*
 * Sets the default context to be the current URL
 */
var _$context_27 = {
  init: function (client, win) {
    if (win === void 0) {
      win = window;
    }

    client.config.beforeSend.unshift(function (report) {
      if (report.context) return;
      report.context = win.location.pathname;
    });
  }
};

function ___extends_28() { ___extends_28 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_28.apply(this, arguments); }

var __isoDate_28 = _$esUtils_8.isoDate;
/*
 * Automatically detects browser device details
 */


var _$device_28 = {
  init: function (client, nav) {
    if (nav === void 0) {
      nav = navigator;
    }

    var device = {
      locale: nav.browserLanguage || nav.systemLanguage || nav.userLanguage || nav.language,
      userAgent: nav.userAgent // merge with anything already set on the client

    };
    client.device = ___extends_28({}, device, client.device); // add time just as the report is sent

    client.config.beforeSend.unshift(function (report) {
      report.device = ___extends_28({}, report.device, {
        time: __isoDate_28()
      });
    });
  }
};

function ___extends_29() { ___extends_29 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_29.apply(this, arguments); }

/*
 * Sets the report request: { url } to be the current href
 */
var _$request_29 = {
  init: function (client, win) {
    if (win === void 0) {
      win = window;
    }

    client.config.beforeSend.unshift(function (report) {
      if (report.request && report.request.url) return;
      report.request = ___extends_29({}, report.request, {
        url: win.location.href
      });
    });
  }
};

function ___extends_30() { ___extends_30 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_30.apply(this, arguments); }

var __isArray_30 = _$esUtils_8.isArray,
    __includes_30 = _$esUtils_8.includes;

/* removed: var _$inferReleaseStage_10 = require('@bugsnag/core/lib/infer-release-stage'); */;

var _$session_30 = {
  init: function (client) {
    return client.sessionDelegate(sessionDelegate);
  }
};
var sessionDelegate = {
  startSession: function (client) {
    var sessionClient = client;
    sessionClient._session = new client.BugsnagSession();
    var releaseStage = _$inferReleaseStage_10(sessionClient); // exit early if the reports should not be sent on the current releaseStage

    if (__isArray_30(sessionClient.config.notifyReleaseStages) && !__includes_30(sessionClient.config.notifyReleaseStages, releaseStage)) {
      sessionClient._logger.warn("Session not sent due to releaseStage/notifyReleaseStages configuration");

      return sessionClient;
    }

    if (!sessionClient.config.endpoints.sessions) {
      sessionClient._logger.warn("Session not sent due to missing endpoints.sessions configuration");

      return sessionClient;
    }

    sessionClient._delivery.sendSession(sessionClient._logger, sessionClient.config, {
      notifier: sessionClient.notifier,
      device: sessionClient.device,
      app: ___extends_30({}, {
        releaseStage: releaseStage
      }, sessionClient.app),
      sessions: [{
        id: sessionClient._session.id,
        startedAt: sessionClient._session.startedAt,
        user: sessionClient.user
      }]
    });

    return sessionClient;
  }
};

function ___extends_31() { ___extends_31 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_31.apply(this, arguments); }

/*
 * Prevent collection of user IPs
 */
var _$clientIp_31 = {
  init: function (client) {
    if (client.config.collectUserIp) return;
    client.config.beforeSend.push(function (report) {
      // If user.id is explicitly undefined, it will be missing from the payload. It needs
      // removing so that the following line replaces it
      if (report.user && typeof report.user.id === 'undefined') delete report.user.id;
      report.user = ___extends_31({
        id: '[NOT COLLECTED]'
      }, report.user);
      report.request = ___extends_31({
        clientIp: '[NOT COLLECTED]'
      }, report.request);
    });
  },
  configSchema: {
    collectUserIp: {
      defaultValue: function () {
        return true;
      },
      message: 'should be true|false',
      validate: function (value) {
        return value === true || value === false;
      }
    }
  }
};

var _$consoleBreadcrumbs_32 = {};
var __map_32 = _$esUtils_8.map,
    __reduce_32 = _$esUtils_8.reduce,
    __filter_32 = _$esUtils_8.filter;
/*
 * Leaves breadcrumbs when console log methods are called
 */


_$consoleBreadcrumbs_32.init = function (client) {
  var isDev = /^dev(elopment)?$/.test(client.config.releaseStage);
  var explicitlyDisabled = client.config.consoleBreadcrumbsEnabled === false;
  var implicitlyDisabled = (client.config.autoBreadcrumbs === false || isDev) && client.config.consoleBreadcrumbsEnabled !== true;
  if (explicitlyDisabled || implicitlyDisabled) return;
  __map_32(CONSOLE_LOG_METHODS, function (method) {
    var original = console[method];

    console[method] = function () {
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      client.leaveBreadcrumb('Console output', __reduce_32(args, function (accum, arg, i) {
        // do the best/simplest stringification of each argument
        var stringified = '[Unknown value]'; // this may fail if the input is:
        // - an object whose [[Prototype]] is null (no toString)
        // - an object with a broken toString or @@toPrimitive implementation

        try {
          stringified = String(arg);
        } catch (e) {} // if it stringifies to [object Object] attempt to JSON stringify


        if (stringified === '[object Object]') {
          // catch stringify errors and fallback to [object Object]
          try {
            stringified = JSON.stringify(arg);
          } catch (e) {}
        }

        accum["[" + i + "]"] = stringified;
        return accum;
      }, {
        severity: method.indexOf('group') === 0 ? 'log' : method
      }), 'log');
      original.apply(console, args);
    };

    console[method]._restore = function () {
      console[method] = original;
    };
  });
};

_$consoleBreadcrumbs_32.configSchema = {
  consoleBreadcrumbsEnabled: {
    defaultValue: function () {
      return undefined;
    },
    validate: function (value) {
      return value === true || value === false || value === undefined;
    },
    message: 'should be true|false'
  }
};

if ("production" !== 'production') {
  _$consoleBreadcrumbs_32.destroy = function () {
    return CONSOLE_LOG_METHODS.forEach(function (method) {
      if (typeof console[method]._restore === 'function') console[method]._restore();
    });
  };
}

var CONSOLE_LOG_METHODS = __filter_32(['log', 'debug', 'info', 'warn', 'error'], function (method) {
  return typeof console !== 'undefined' && typeof console[method] === 'function';
});

var _$inlineScriptContent_33 = {};
var __reduce_33 = _$esUtils_8.reduce;

_$inlineScriptContent_33 = {
  init: function (client, doc, win) {
    if (doc === void 0) {
      doc = document;
    }

    if (win === void 0) {
      win = window;
    }

    var html = '';
    var DOMContentLoaded = false;

    var getHtml = function () {
      return doc.documentElement.outerHTML;
    };

    var originalLocation = win.location.href;

    var addInlineContent = function (report) {
      var frame = report.stacktrace[0];
      if (!frame || !frame.file || !frame.lineNumber) return frame;
      if (frame.file.replace(/#.*$/, '') !== originalLocation.replace(/#.*$/, '')) return frame;
      if (!DOMContentLoaded || !html) html = getHtml();
      var htmlLines = ['<!-- DOC START -->'].concat(html.split('\n'));

      var _extractScriptContent = extractScriptContent(htmlLines, frame.lineNumber - 1),
          script = _extractScriptContent.script,
          start = _extractScriptContent.start;

      var code = __reduce_33(script, function (accum, line, i) {
        if (Math.abs(start + i + 1 - frame.lineNumber) > 10) return accum;
        accum["" + (start + i + 1)] = line;
        return accum;
      }, {});
      frame.code = code;
      report.updateMetaData('script', {
        content: script.join('\n')
      });
    }; // get whatever HTML exists at this point in time


    html = getHtml();
    var prev = doc.onreadystatechange; // then update it when the DOM content has loaded

    doc.onreadystatechange = function () {
      // IE8 compatible alternative to document#DOMContentLoaded
      if (doc.readyState === 'interactive') {
        html = getHtml();
        DOMContentLoaded = true;
      }

      if (typeof prev === 'function') prev.apply(this, arguments);
    };

    client.config.beforeSend.unshift(addInlineContent);
  }
};
var scriptStartRe = /^.*<script.*?>/;
var scriptEndRe = /<\/script>.*$/;

var extractScriptContent = _$inlineScriptContent_33.extractScriptContent = function (lines, startLine) {
  // search down for </script>
  var line = startLine;

  while (line < lines.length && !scriptEndRe.test(lines[line])) {
    line++;
  } // search up for <script>


  var end = line;

  while (line > 0 && !scriptStartRe.test(lines[line])) {
    line--;
  }

  var start = line; // strip <script> tags so that lines just contain js content

  var script = lines.slice(start, end + 1);
  script[0] = script[0].replace(scriptStartRe, '');
  script[script.length - 1] = script[script.length - 1].replace(scriptEndRe, ''); // return the array of lines, and the line number the script started at

  return {
    script: script,
    start: start
  };
};

/*
 * Leaves breadcrumbs when the user interacts with the DOM
 */
var _$interactionBreadcrumbs_34 = {
  init: function (client, win) {
    if (win === void 0) {
      win = window;
    }

    if (!('addEventListener' in win)) return;
    var explicitlyDisabled = client.config.interactionBreadcrumbsEnabled === false;
    var implicitlyDisabled = client.config.autoBreadcrumbs === false && client.config.interactionBreadcrumbsEnabled !== true;
    if (explicitlyDisabled || implicitlyDisabled) return;
    win.addEventListener('click', function (event) {
      var targetText, targetSelector;

      try {
        targetText = getNodeText(event.target);
        targetSelector = getNodeSelector(event.target, win);
      } catch (e) {
        targetText = '[hidden]';
        targetSelector = '[hidden]';

        client._logger.error('Cross domain error when tracking click event. See docs: https://tinyurl.com/y94fq5zm');
      }

      client.leaveBreadcrumb('UI click', {
        targetText: targetText,
        targetSelector: targetSelector
      }, 'user');
    }, true);
  },
  configSchema: {
    interactionBreadcrumbsEnabled: {
      defaultValue: function () {
        return undefined;
      },
      validate: function (value) {
        return value === true || value === false || value === undefined;
      },
      message: 'should be true|false'
    }
  } // extract text content from a element

};

var getNodeText = function (el) {
  var text = el.textContent || el.innerText || '';
  if (!text && (el.type === 'submit' || el.type === 'button')) text = el.value;
  text = text.replace(/^\s+|\s+$/g, ''); // trim whitespace

  return truncate(text, 140);
}; // Create a label from tagname, id and css class of the element


function getNodeSelector(el, win) {
  var parts = [el.tagName];
  if (el.id) parts.push('#' + el.id);
  if (el.className && el.className.length) parts.push("." + el.className.split(' ').join('.')); // Can't get much more advanced with the current browser

  if (!win.document.querySelectorAll || !Array.prototype.indexOf) return parts.join('');

  try {
    if (win.document.querySelectorAll(parts.join('')).length === 1) return parts.join('');
  } catch (e) {
    // Sometimes the query selector can be invalid just return it as-is
    return parts.join('');
  } // try to get a more specific selector if this one matches more than one element


  if (el.parentNode.childNodes.length > 1) {
    var index = Array.prototype.indexOf.call(el.parentNode.childNodes, el) + 1;
    parts.push(":nth-child(" + index + ")");
  }

  if (win.document.querySelectorAll(parts.join('')).length === 1) return parts.join(''); // try prepending the parent node selector

  if (el.parentNode) return getNodeSelector(el.parentNode, win) + " > " + parts.join('');
  return parts.join('');
}

function truncate(value, length) {
  var ommision = '(...)';
  if (value && value.length <= length) return value;
  return value.slice(0, length - ommision.length) + ommision;
}

var _$navigationBreadcrumbs_35 = {};
/*
 * Leaves breadcrumbs when navigation methods are called or events are emitted
 */
_$navigationBreadcrumbs_35.init = function (client, win) {
  if (win === void 0) {
    win = window;
  }

  if (!('addEventListener' in win)) return;
  var explicitlyDisabled = client.config.navigationBreadcrumbsEnabled === false;
  var implicitlyDisabled = client.config.autoBreadcrumbs === false && client.config.navigationBreadcrumbsEnabled !== true;
  if (explicitlyDisabled || implicitlyDisabled) return; // returns a function that will drop a breadcrumb with a given name

  var drop = function (name) {
    return function () {
      return client.leaveBreadcrumb(name, {}, 'navigation');
    };
  }; // simple drops – just names, no meta


  win.addEventListener('pagehide', drop('Page hidden'), true);
  win.addEventListener('pageshow', drop('Page shown'), true);
  win.addEventListener('load', drop('Page loaded'), true);
  win.document.addEventListener('DOMContentLoaded', drop('DOMContentLoaded'), true); // some browsers like to emit popstate when the page loads, so only add the popstate listener after that

  win.addEventListener('load', function () {
    return win.addEventListener('popstate', drop('Navigated back'), true);
  }); // hashchange has some metaData that we care about

  win.addEventListener('hashchange', function (event) {
    var metaData = event.oldURL ? {
      from: relativeLocation(event.oldURL, win),
      to: relativeLocation(event.newURL, win),
      state: getCurrentState(win)
    } : {
      to: relativeLocation(win.location.href, win)
    };
    client.leaveBreadcrumb('Hash changed', metaData, 'navigation');
  }, true); // the only way to know about replaceState/pushState is to wrap them… >_<

  if (win.history.replaceState) wrapHistoryFn(client, win.history, 'replaceState', win);
  if (win.history.pushState) wrapHistoryFn(client, win.history, 'pushState', win);
  client.leaveBreadcrumb('Bugsnag loaded', {}, 'navigation');
};

_$navigationBreadcrumbs_35.configSchema = {
  navigationBreadcrumbsEnabled: {
    defaultValue: function () {
      return undefined;
    },
    validate: function (value) {
      return value === true || value === false || value === undefined;
    },
    message: 'should be true|false'
  }
};

if ("production" !== 'production') {
  _$navigationBreadcrumbs_35.destroy = function (win) {
    if (win === void 0) {
      win = window;
    }

    win.history.replaceState._restore();

    win.history.pushState._restore();
  };
} // takes a full url like http://foo.com:1234/pages/01.html?yes=no#section-2 and returns
// just the path and hash parts, e.g. /pages/01.html?yes=no#section-2


var relativeLocation = function (url, win) {
  var a = win.document.createElement('A');
  a.href = url;
  return "" + a.pathname + a.search + a.hash;
};

var stateChangeToMetaData = function (win, state, title, url) {
  var currentPath = relativeLocation(win.location.href, win);
  return {
    title: title,
    state: state,
    prevState: getCurrentState(win),
    to: url || currentPath,
    from: currentPath
  };
};

var wrapHistoryFn = function (client, target, fn, win) {
  var orig = target[fn];

  target[fn] = function (state, title, url) {
    client.leaveBreadcrumb("History " + fn, stateChangeToMetaData(win, state, title, url), 'navigation'); // if throttle plugin is in use, refresh the event sent count

    if (typeof client.refresh === 'function') client.refresh(); // if the client is operating in auto session-mode, a new route should trigger a new session

    if (client.config.autoCaptureSessions) client.startSession(); // Internet Explorer will convert `undefined` to a string when passed, causing an unintended redirect
    // to '/undefined'. therefore we only pass the url if it's not undefined.

    orig.apply(target, [state, title].concat(url !== undefined ? url : []));
  };

  target[fn]._restore = function () {
    target[fn] = orig;
  };
};

var getCurrentState = function (win) {
  try {
    return win.history.state;
  } catch (e) {}
};

var _$networkBreadcrumbs_36 = {};
var BREADCRUMB_TYPE = 'request'; // keys to safely store metadata on the request object

var REQUEST_SETUP_KEY = 'BS~~S';
var REQUEST_URL_KEY = 'BS~~U';
var REQUEST_METHOD_KEY = 'BS~~M';

var __includes_36 = _$esUtils_8.includes;

var restoreFunctions = [];
var client;
var win;

var getEndpoints = function () {
  return [client.config.endpoints.notify, client.config.endpoints.sessions];
};
/*
 * Leaves breadcrumbs when network requests occur
 */


_$networkBreadcrumbs_36.init = function (_client, _win) {
  if (_win === void 0) {
    _win = window;
  }

  var explicitlyDisabled = _client.config.networkBreadcrumbsEnabled === false;
  var implicitlyDisabled = _client.config.autoBreadcrumbs === false && _client.config.networkBreadcrumbsEnabled !== true;
  if (explicitlyDisabled || implicitlyDisabled) return;
  client = _client;
  win = _win;
  monkeyPatchXMLHttpRequest();
  monkeyPatchFetch();
};

_$networkBreadcrumbs_36.configSchema = {
  networkBreadcrumbsEnabled: {
    defaultValue: function () {
      return undefined;
    },
    validate: function (value) {
      return value === true || value === false || value === undefined;
    },
    message: 'should be true|false'
  }
};

if ("production" !== 'production') {
  _$networkBreadcrumbs_36.destroy = function () {
    restoreFunctions.forEach(function (fn) {
      return fn();
    });
    restoreFunctions = [];
  };
} // XMLHttpRequest monkey patch


var monkeyPatchXMLHttpRequest = function () {
  if (!('addEventListener' in win.XMLHttpRequest.prototype)) return;
  var nativeOpen = win.XMLHttpRequest.prototype.open; // override native open()

  win.XMLHttpRequest.prototype.open = function open(method, url) {
    // store url and HTTP method for later
    this[REQUEST_URL_KEY] = url;
    this[REQUEST_METHOD_KEY] = method; // if we have already setup listeners, it means open() was called twice, we need to remove
    // the listeners and recreate them

    if (this[REQUEST_SETUP_KEY]) {
      this.removeEventListener('load', handleXHRLoad);
      this.removeEventListener('error', handleXHRError);
    } // attach load event listener


    this.addEventListener('load', handleXHRLoad); // attach error event listener

    this.addEventListener('error', handleXHRError);
    this[REQUEST_SETUP_KEY] = true;
    nativeOpen.apply(this, arguments);
  };

  if ("production" !== 'production') {
    restoreFunctions.push(function () {
      win.XMLHttpRequest.prototype.open = nativeOpen;
    });
  }
};

function handleXHRLoad() {
  if (__includes_36(getEndpoints(), this[REQUEST_URL_KEY])) {
    // don't leave a network breadcrumb from bugsnag notify calls
    return;
  }

  var metaData = {
    status: this.status,
    request: this[REQUEST_METHOD_KEY] + " " + this[REQUEST_URL_KEY]
  };

  if (this.status >= 400) {
    // contacted server but got an error response
    client.leaveBreadcrumb('XMLHttpRequest failed', metaData, BREADCRUMB_TYPE);
  } else {
    client.leaveBreadcrumb('XMLHttpRequest succeeded', metaData, BREADCRUMB_TYPE);
  }
}

function handleXHRError() {
  if (__includes_36(getEndpoints(), this[REQUEST_URL_KEY])) {
    // don't leave a network breadcrumb from bugsnag notify calls
    return;
  } // failed to contact server


  client.leaveBreadcrumb('XMLHttpRequest error', {
    request: this[REQUEST_METHOD_KEY] + " " + this[REQUEST_URL_KEY]
  }, BREADCRUMB_TYPE);
} // window.fetch monkey patch


var monkeyPatchFetch = function () {
  if (!('fetch' in win)) return;
  var oldFetch = win.fetch;

  win.fetch = function fetch() {
    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    var url = args[0],
        options = args[1];
    var method = 'GET';

    if (options && options.method) {
      method = options.method;
    }

    return new Promise(function (resolve, reject) {
      // pass through to native fetch
      oldFetch.apply(void 0, args).then(function (response) {
        handleFetchSuccess(response, method, url);
        resolve(response);
      })["catch"](function (error) {
        handleFetchError(method, url);
        reject(error);
      });
    });
  };

  if ("production" !== 'production') {
    restoreFunctions.push(function () {
      win.fetch = oldFetch;
    });
  }
};

var handleFetchSuccess = function (response, method, url) {
  var metaData = {
    status: response.status,
    request: method + " " + url
  };

  if (response.status >= 400) {
    // when the request comes back with a 4xx or 5xx status it does not reject the fetch promise,
    client.leaveBreadcrumb('fetch() failed', metaData, BREADCRUMB_TYPE);
  } else {
    client.leaveBreadcrumb('fetch() succeeded', metaData, BREADCRUMB_TYPE);
  }
};

var handleFetchError = function (method, url) {
  client.leaveBreadcrumb('fetch() error', {
    request: method + " " + url
  }, BREADCRUMB_TYPE);
};

var __intRange_37 = _$validators_14.intRange;
/*
 * Throttles and dedupes error reports
 */


var _$throttle_37 = {
  init: function (client) {
    // track sent events for each init of the plugin
    var n = 0; // add beforeSend hook

    client.config.beforeSend.push(function (report) {
      // have max events been sent already?
      if (n >= client.config.maxEvents) return report.ignore();
      n++;
    });

    client.refresh = function () {
      n = 0;
    };
  },
  configSchema: {
    maxEvents: {
      defaultValue: function () {
        return 10;
      },
      message: 'should be a positive integer ≤100',
      validate: function (val) {
        return __intRange_37(1, 100)(val);
      }
    }
  }
};

var _$stripQueryString_38 = {};
function ___extends_38() { ___extends_38 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_38.apply(this, arguments); }

/*
 * Remove query strings (and fragments) from stacktraces
 */
var __map_38 = _$esUtils_8.map;

_$stripQueryString_38 = {
  init: function (client) {
    client.config.beforeSend.push(function (report) {
      report.stacktrace = __map_38(report.stacktrace, function (frame) {
        return ___extends_38({}, frame, {
          file: strip(frame.file)
        });
      });
    });
  }
};

var strip = _$stripQueryString_38._strip = function (str) {
  return typeof str === 'string' ? str.replace(/\?.*$/, '').replace(/#.*$/, '') : str;
};

/*
 * Automatically notifies Bugsnag when window.onerror is called
 */
var _$onerror_39 = {
  init: function (client, win) {
    if (win === void 0) {
      win = window;
    }

    function onerror(messageOrEvent, url, lineNo, charNo, error) {
      // Ignore errors with no info due to CORS settings
      if (lineNo === 0 && /Script error\.?/.test(messageOrEvent)) {
        client._logger.warn('Ignoring cross-domain or eval script error. See docs: https://tinyurl.com/y94fq5zm');
      } else {
        // any error sent to window.onerror is unhandled and has severity=error
        var handledState = {
          severity: 'error',
          unhandled: true,
          severityReason: {
            type: 'unhandledException'
          }
        };
        var report; // window.onerror can be called in a number of ways. This big if-else is how we
        // figure out which arguments were supplied, and what kind of values it received.

        if (error) {
          // if the last parameter (error) was supplied, this is a modern browser's
          // way of saying "this value was thrown and not caught"
          if (error.name && error.message) {
            // if it looks like an error, construct a report object using its stack
            report = new client.BugsnagReport(error.name, error.message, decorateStack(client.BugsnagReport.getStacktrace(error), url, lineNo, charNo), handledState, error);
          } else {
            // otherwise, for non error values that were thrown, stringify it for
            // use as the error message and get/generate a stacktrace
            report = new client.BugsnagReport('window.onerror', String(error), decorateStack(client.BugsnagReport.getStacktrace(error, 1), url, lineNo, charNo), handledState, error); // include the raw input as metadata

            report.updateMetaData('window onerror', {
              error: error
            });
          }
        } else if ( // This complex case detects "error" events that are typically synthesised
        // by jquery's trigger method (although can be created in other ways). In
        // order to detect this:
        // - the first argument (message) must exist and be an object (most likely it's a jQuery event)
        // - the second argument (url) must either not exist or be something other than a string (if it
        //    exists and is not a string, it'll be the extraParameters argument from jQuery's trigger()
        //    function)
        // - the third, fourth and fifth arguments must not exist (lineNo, charNo and error)
        typeof messageOrEvent === 'object' && messageOrEvent !== null && (!url || typeof url !== 'string') && !lineNo && !charNo && !error) {
          // The jQuery event may have a "type" property, if so use it as part of the error message
          var name = messageOrEvent.type ? "Event: " + messageOrEvent.type : 'window.onerror'; // attempt to find a message from one of the conventional properties, but
          // default to empty string (the report will fill it with a placeholder)

          var message = messageOrEvent.message || messageOrEvent.detail || '';
          report = new client.BugsnagReport(name, message, client.BugsnagReport.getStacktrace(new Error(), 1).slice(1), handledState, messageOrEvent); // include the raw input as metadata – it might contain more info than we extracted

          report.updateMetaData('window onerror', {
            event: messageOrEvent,
            extraParameters: url
          });
        } else {
          // Lastly, if there was no "error" parameter this event was probably from an old
          // browser that doesn't support that. Instead we need to generate a stacktrace.
          report = new client.BugsnagReport('window.onerror', String(messageOrEvent), decorateStack(client.BugsnagReport.getStacktrace(error, 1), url, lineNo, charNo), handledState, messageOrEvent); // include the raw input as metadata – it might contain more info than we extracted

          report.updateMetaData('window onerror', {
            event: messageOrEvent
          });
        }

        client.notify(report);
      }

      if (typeof prevOnError === 'function') prevOnError.apply(this, arguments);
    }

    var prevOnError = win.onerror;
    win.onerror = onerror;
  } // Sometimes the stacktrace has less information than was passed to window.onerror.
  // This function will augment the first stackframe with any useful info that was
  // received as arguments to the onerror callback.

};

var decorateStack = function (stack, url, lineNo, charNo) {
  var culprit = stack[0];
  if (!culprit) return stack;
  if (!culprit.fileName && typeof url === 'string') culprit.setFileName(url);
  if (!culprit.lineNumber && isActualNumber(lineNo)) culprit.setLineNumber(lineNo);

  if (!culprit.columnNumber) {
    if (isActualNumber(charNo)) {
      culprit.setColumnNumber(charNo);
    } else if (window.event && isActualNumber(window.event.errorCharacter)) {
      culprit.setColumnNumber(window.event.errorCharacter);
    }
  }

  return stack;
};

var isActualNumber = function (n) {
  return typeof n === 'number' && String.call(n) !== 'NaN';
};

var _$unhandledRejection_40 = {};
/* removed: var _$hasStack_9 = require('@bugsnag/core/lib/has-stack'); */;

var __reduce_40 = _$esUtils_8.reduce;

/* removed: var _$errorStackParser_7 = require('@bugsnag/core/lib/error-stack-parser'); */;

/* removed: var _$iserror_11 = require('@bugsnag/core/lib/iserror'); */;
/*
 * Automatically notifies Bugsnag when window.onunhandledrejection is called
 */


var _listener;

_$unhandledRejection_40.init = function (client, win) {
  if (win === void 0) {
    win = window;
  }

  var listener = function (event) {
    var error = event.reason;
    var isBluebird = false; // accessing properties on event.detail can throw errors (see #394)

    try {
      if (event.detail && event.detail.reason) {
        error = event.detail.reason;
        isBluebird = true;
      }
    } catch (e) {}

    var handledState = {
      severity: 'error',
      unhandled: true,
      severityReason: {
        type: 'unhandledPromiseRejection'
      }
    };
    var report;

    if (error && _$hasStack_9(error)) {
      // if it quacks like an Error…
      report = new client.BugsnagReport(error.name, error.message, _$errorStackParser_7.parse(error), handledState, error);

      if (isBluebird) {
        report.stacktrace = __reduce_40(report.stacktrace, fixBluebirdStacktrace(error), []);
      }
    } else {
      // if it doesn't…
      var msg = 'Rejection reason was not an Error. See "Promise" tab for more detail.';
      report = new client.BugsnagReport(error && error.name ? error.name : 'UnhandledRejection', error && error.message ? error.message : msg, [], handledState, error); // stuff the rejection reason into metaData, it could be useful

      report.updateMetaData('promise', 'rejection reason', serializableReason(error));
    }

    client.notify(report);
  };

  if ('addEventListener' in win) {
    win.addEventListener('unhandledrejection', listener);
  } else {
    win.onunhandledrejection = function (reason, promise) {
      listener({
        detail: {
          reason: reason,
          promise: promise
        }
      });
    };
  }

  _listener = listener;
};

if ("production" !== 'production') {
  _$unhandledRejection_40.destroy = function (win) {
    if (win === void 0) {
      win = window;
    }

    if (_listener) {
      if ('addEventListener' in win) {
        win.removeEventListener('unhandledrejection', _listener);
      } else {
        win.onunhandledrejection = null;
      }
    }

    _listener = null;
  };
}

var serializableReason = function (err) {
  if (err === null || err === undefined) {
    return 'undefined (or null)';
  } else if (_$iserror_11(err)) {
    var _ref;

    return _ref = {}, _ref[Object.prototype.toString.call(err)] = {
      name: err.name,
      message: err.message,
      code: err.code,
      stack: err.stack
    }, _ref;
  } else {
    return err;
  }
}; // The stack parser on bluebird stacks in FF get a suprious first frame:
//
// Error: derp
//   b@http://localhost:5000/bluebird.html:22:24
//   a@http://localhost:5000/bluebird.html:18:9
//   @http://localhost:5000/bluebird.html:14:9
//
// results in
//   […]
//     0: Object { file: "Error: derp", method: undefined, lineNumber: undefined, … }
//     1: Object { file: "http://localhost:5000/bluebird.html", method: "b", lineNumber: 22, … }
//     2: Object { file: "http://localhost:5000/bluebird.html", method: "a", lineNumber: 18, … }
//     3: Object { file: "http://localhost:5000/bluebird.html", lineNumber: 14, columnNumber: 9, … }
//
// so the following reduce/accumulator function removes such frames
//
// Bluebird pads method names with spaces so trim that too…
// https://github.com/petkaantonov/bluebird/blob/b7f21399816d02f979fe434585334ce901dcaf44/src/debuggability.js#L568-L571


var fixBluebirdStacktrace = function (error) {
  return function (accum, frame) {
    if (frame.file === error.toString()) return accum;

    if (frame.method) {
      frame.method = frame.method.replace(/^\s+/, '');
    }

    return accum.concat(frame);
  };
};

var _$notifier_2 = {};
function ___extends_2() { ___extends_2 = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return ___extends_2.apply(this, arguments); }

var name = 'Bugsnag JavaScript';
var version = '6.1.0';
var url = 'https://github.com/bugsnag/bugsnag-js';

/* removed: var _$BugsnagClient_4 = require('@bugsnag/core/client'); */;

/* removed: var _$BugsnagReport_23 = require('@bugsnag/core/report'); */;

/* removed: var _$Session_24 = require('@bugsnag/core/session'); */;

/* removed: var _$BugsnagBreadcrumb_3 = require('@bugsnag/core/breadcrumb'); */;

var __map_2 = _$esUtils_8.map; // extend the base config schema with some browser-specific options


var __schema_2 = ___extends_2({}, _$config_5.schema, _$config_1);

/* removed: var _$onerror_39 = require('@bugsnag/plugin-window-onerror'); */;

/* removed: var _$unhandledRejection_40 = require('@bugsnag/plugin-window-unhandled-rejection'); */;

/* removed: var _$device_28 = require('@bugsnag/plugin-browser-device'); */;

/* removed: var _$context_27 = require('@bugsnag/plugin-browser-context'); */;

/* removed: var _$request_29 = require('@bugsnag/plugin-browser-request'); */;

/* removed: var _$throttle_37 = require('@bugsnag/plugin-simple-throttle'); */;

/* removed: var _$consoleBreadcrumbs_32 = require('@bugsnag/plugin-console-breadcrumbs'); */;

/* removed: var _$networkBreadcrumbs_36 = require('@bugsnag/plugin-network-breadcrumbs'); */;

/* removed: var _$navigationBreadcrumbs_35 = require('@bugsnag/plugin-navigation-breadcrumbs'); */;

/* removed: var _$interactionBreadcrumbs_34 = require('@bugsnag/plugin-interaction-breadcrumbs'); */;

/* removed: var _$inlineScriptContent_33 = require('@bugsnag/plugin-inline-script-content'); */;

/* removed: var _$session_30 = require('@bugsnag/plugin-browser-session'); */;

/* removed: var _$clientIp_31 = require('@bugsnag/plugin-client-ip'); */;

/* removed: var _$stripQueryString_38 = require('@bugsnag/plugin-strip-query-string'); */; // delivery mechanisms


/* removed: var _$delivery_25 = require('@bugsnag/delivery-x-domain-request'); */;

/* removed: var _$delivery_26 = require('@bugsnag/delivery-xml-http-request'); */;

_$notifier_2 = function (opts) {
  // handle very simple use case where user supplies just the api key as a string
  if (typeof opts === 'string') opts = {
    apiKey: opts // support renamed/deprecated options

  };
  var warnings = [];

  if (opts.sessionTrackingEnabled) {
    warnings.push('deprecated option sessionTrackingEnabled is now called autoCaptureSessions');
    opts.autoCaptureSessions = opts.sessionTrackingEnabled;
  }

  if ((opts.endpoint || opts.sessionEndpoint) && !opts.endpoints) {
    warnings.push('deprecated options endpoint/sessionEndpoint are now configured in the endpoints object');
    opts.endpoints = {
      notify: opts.endpoint,
      sessions: opts.sessionEndpoint
    };
  }

  if (opts.endpoints && opts.endpoints.notify && !opts.endpoints.sessions) {
    warnings.push('notify endpoint is set but sessions endpoint is not. No sessions will be sent.');
  }

  var bugsnag = new _$BugsnagClient_4({
    name: name,
    version: version,
    url: url
  });
  bugsnag.setOptions(opts); // set delivery based on browser capability (IE 8+9 have an XDomainRequest object)

  bugsnag.delivery(window.XDomainRequest ? _$delivery_25() : _$delivery_26()); // configure with user supplied options
  // errors can be thrown here that prevent the lib from being in a useable state

  bugsnag.configure(__schema_2);
  __map_2(warnings, function (w) {
    return bugsnag._logger.warn(w);
  }); // always-on browser-specific plugins

  bugsnag.use(_$device_28);
  bugsnag.use(_$context_27);
  bugsnag.use(_$request_29);
  bugsnag.use(_$inlineScriptContent_33);
  bugsnag.use(_$throttle_37);
  bugsnag.use(_$session_30);
  bugsnag.use(_$clientIp_31);
  bugsnag.use(_$stripQueryString_38); // optional browser-specific plugins

  if (bugsnag.config.autoNotify !== false) {
    bugsnag.use(_$onerror_39);
    bugsnag.use(_$unhandledRejection_40);
  }

  bugsnag.use(_$navigationBreadcrumbs_35);
  bugsnag.use(_$interactionBreadcrumbs_34);
  bugsnag.use(_$networkBreadcrumbs_36);
  bugsnag.use(_$consoleBreadcrumbs_32);

  bugsnag._logger.debug("Loaded!");

  return bugsnag.config.autoCaptureSessions ? bugsnag.startSession() : bugsnag;
}; // Stub this value because this is what the type interface looks like
// (types/bugsnag.d.ts). This is only an issue in Angular's development
// mode as its TS/DI thingy attempts to use this value at runtime.
// In most other situations, TS only uses the types at compile time.


_$notifier_2.Bugsnag = {
  Client: _$BugsnagClient_4,
  Report: _$BugsnagReport_23,
  Session: _$Session_24,
  Breadcrumb: _$BugsnagBreadcrumb_3 // Export a "default" property for compatibility with ESM imports

};
_$notifier_2['default'] = _$notifier_2;

return _$notifier_2;

});


}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],30:[function(require,module,exports){
module.exports = require('@bugsnag/browser')

},{"@bugsnag/browser":29}],31:[function(require,module,exports){
module.exports = after

function after(count, callback, err_cb) {
    var bail = false
    err_cb = err_cb || noop
    proxy.count = count

    return (count === 0) ? callback() : proxy

    function proxy(err, result) {
        if (proxy.count <= 0) {
            throw new Error('after called too many times')
        }
        --proxy.count

        // after first error, rest are passed to err_cb
        if (err) {
            bail = true
            callback(err)
            // future error callbacks will go to error handler
            callback = err_cb
        } else if (proxy.count === 0 && !bail) {
            callback(null, result)
        }
    }
}

function noop() {}

},{}],32:[function(require,module,exports){
/**
 * An abstraction for slicing an arraybuffer even when
 * ArrayBuffer.prototype.slice is not supported
 *
 * @api public
 */

module.exports = function(arraybuffer, start, end) {
  var bytes = arraybuffer.byteLength;
  start = start || 0;
  end = end || bytes;

  if (arraybuffer.slice) { return arraybuffer.slice(start, end); }

  if (start < 0) { start += bytes; }
  if (end < 0) { end += bytes; }
  if (end > bytes) { end = bytes; }

  if (start >= bytes || start >= end || bytes === 0) {
    return new ArrayBuffer(0);
  }

  var abv = new Uint8Array(arraybuffer);
  var result = new Uint8Array(end - start);
  for (var i = start, ii = 0; i < end; i++, ii++) {
    result[ii] = abv[i];
  }
  return result.buffer;
};

},{}],33:[function(require,module,exports){

/**
 * Expose `Backoff`.
 */

module.exports = Backoff;

/**
 * Initialize backoff timer with `opts`.
 *
 * - `min` initial timeout in milliseconds [100]
 * - `max` max timeout [10000]
 * - `jitter` [0]
 * - `factor` [2]
 *
 * @param {Object} opts
 * @api public
 */

function Backoff(opts) {
  opts = opts || {};
  this.ms = opts.min || 100;
  this.max = opts.max || 10000;
  this.factor = opts.factor || 2;
  this.jitter = opts.jitter > 0 && opts.jitter <= 1 ? opts.jitter : 0;
  this.attempts = 0;
}

/**
 * Return the backoff duration.
 *
 * @return {Number}
 * @api public
 */

Backoff.prototype.duration = function(){
  var ms = this.ms * Math.pow(this.factor, this.attempts++);
  if (this.jitter) {
    var rand =  Math.random();
    var deviation = Math.floor(rand * this.jitter * ms);
    ms = (Math.floor(rand * 10) & 1) == 0  ? ms - deviation : ms + deviation;
  }
  return Math.min(ms, this.max) | 0;
};

/**
 * Reset the number of attempts.
 *
 * @api public
 */

Backoff.prototype.reset = function(){
  this.attempts = 0;
};

/**
 * Set the minimum duration
 *
 * @api public
 */

Backoff.prototype.setMin = function(min){
  this.ms = min;
};

/**
 * Set the maximum duration
 *
 * @api public
 */

Backoff.prototype.setMax = function(max){
  this.max = max;
};

/**
 * Set the jitter
 *
 * @api public
 */

Backoff.prototype.setJitter = function(jitter){
  this.jitter = jitter;
};


},{}],34:[function(require,module,exports){
/*
 * base64-arraybuffer
 * https://github.com/niklasvh/base64-arraybuffer
 *
 * Copyright (c) 2012 Niklas von Hertzen
 * Licensed under the MIT license.
 */
(function(){
  "use strict";

  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Use a lookup table to find the index.
  var lookup = new Uint8Array(256);
  for (var i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  exports.encode = function(arraybuffer) {
    var bytes = new Uint8Array(arraybuffer),
    i, len = bytes.length, base64 = "";

    for (i = 0; i < len; i+=3) {
      base64 += chars[bytes[i] >> 2];
      base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
      base64 += chars[bytes[i + 2] & 63];
    }

    if ((len % 3) === 2) {
      base64 = base64.substring(0, base64.length - 1) + "=";
    } else if (len % 3 === 1) {
      base64 = base64.substring(0, base64.length - 2) + "==";
    }

    return base64;
  };

  exports.decode =  function(base64) {
    var bufferLength = base64.length * 0.75,
    len = base64.length, i, p = 0,
    encoded1, encoded2, encoded3, encoded4;

    if (base64[base64.length - 1] === "=") {
      bufferLength--;
      if (base64[base64.length - 2] === "=") {
        bufferLength--;
      }
    }

    var arraybuffer = new ArrayBuffer(bufferLength),
    bytes = new Uint8Array(arraybuffer);

    for (i = 0; i < len; i+=4) {
      encoded1 = lookup[base64.charCodeAt(i)];
      encoded2 = lookup[base64.charCodeAt(i+1)];
      encoded3 = lookup[base64.charCodeAt(i+2)];
      encoded4 = lookup[base64.charCodeAt(i+3)];

      bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }

    return arraybuffer;
  };
})();

},{}],35:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  for (var i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],36:[function(require,module,exports){
/**
 * Create a blob builder even when vendor prefixes exist
 */

var BlobBuilder = typeof BlobBuilder !== 'undefined' ? BlobBuilder :
  typeof WebKitBlobBuilder !== 'undefined' ? WebKitBlobBuilder :
  typeof MSBlobBuilder !== 'undefined' ? MSBlobBuilder :
  typeof MozBlobBuilder !== 'undefined' ? MozBlobBuilder : 
  false;

/**
 * Check if Blob constructor is supported
 */

var blobSupported = (function() {
  try {
    var a = new Blob(['hi']);
    return a.size === 2;
  } catch(e) {
    return false;
  }
})();

/**
 * Check if Blob constructor supports ArrayBufferViews
 * Fails in Safari 6, so we need to map to ArrayBuffers there.
 */

var blobSupportsArrayBufferView = blobSupported && (function() {
  try {
    var b = new Blob([new Uint8Array([1,2])]);
    return b.size === 2;
  } catch(e) {
    return false;
  }
})();

/**
 * Check if BlobBuilder is supported
 */

var blobBuilderSupported = BlobBuilder
  && BlobBuilder.prototype.append
  && BlobBuilder.prototype.getBlob;

/**
 * Helper function that maps ArrayBufferViews to ArrayBuffers
 * Used by BlobBuilder constructor and old browsers that didn't
 * support it in the Blob constructor.
 */

function mapArrayBufferViews(ary) {
  return ary.map(function(chunk) {
    if (chunk.buffer instanceof ArrayBuffer) {
      var buf = chunk.buffer;

      // if this is a subarray, make a copy so we only
      // include the subarray region from the underlying buffer
      if (chunk.byteLength !== buf.byteLength) {
        var copy = new Uint8Array(chunk.byteLength);
        copy.set(new Uint8Array(buf, chunk.byteOffset, chunk.byteLength));
        buf = copy.buffer;
      }

      return buf;
    }

    return chunk;
  });
}

function BlobBuilderConstructor(ary, options) {
  options = options || {};

  var bb = new BlobBuilder();
  mapArrayBufferViews(ary).forEach(function(part) {
    bb.append(part);
  });

  return (options.type) ? bb.getBlob(options.type) : bb.getBlob();
};

function BlobConstructor(ary, options) {
  return new Blob(mapArrayBufferViews(ary), options || {});
};

if (typeof Blob !== 'undefined') {
  BlobBuilderConstructor.prototype = Blob.prototype;
  BlobConstructor.prototype = Blob.prototype;
}

module.exports = (function() {
  if (blobSupported) {
    return blobSupportsArrayBufferView ? Blob : BlobConstructor;
  } else if (blobBuilderSupported) {
    return BlobBuilderConstructor;
  } else {
    return undefined;
  }
})();

},{}],37:[function(require,module,exports){

},{}],38:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

},{"base64-js":35,"ieee754":49}],39:[function(require,module,exports){
/**
 * Slice reference.
 */

var slice = [].slice;

/**
 * Bind `obj` to `fn`.
 *
 * @param {Object} obj
 * @param {Function|String} fn or string
 * @return {Function}
 * @api public
 */

module.exports = function(obj, fn){
  if ('string' == typeof fn) fn = obj[fn];
  if ('function' != typeof fn) throw new Error('bind() requires a function');
  var args = slice.call(arguments, 2);
  return function(){
    return fn.apply(obj, args.concat(slice.call(arguments)));
  }
};

},{}],40:[function(require,module,exports){

/**
 * Expose `Emitter`.
 */

if (typeof module !== 'undefined') {
  module.exports = Emitter;
}

/**
 * Initialize a new `Emitter`.
 *
 * @api public
 */

function Emitter(obj) {
  if (obj) return mixin(obj);
};

/**
 * Mixin the emitter properties.
 *
 * @param {Object} obj
 * @return {Object}
 * @api private
 */

function mixin(obj) {
  for (var key in Emitter.prototype) {
    obj[key] = Emitter.prototype[key];
  }
  return obj;
}

/**
 * Listen on the given `event` with `fn`.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.on =
Emitter.prototype.addEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};
  (this._callbacks['$' + event] = this._callbacks['$' + event] || [])
    .push(fn);
  return this;
};

/**
 * Adds an `event` listener that will be invoked a single
 * time then automatically removed.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.once = function(event, fn){
  function on() {
    this.off(event, on);
    fn.apply(this, arguments);
  }

  on.fn = fn;
  this.on(event, on);
  return this;
};

/**
 * Remove the given callback for `event` or all
 * registered callbacks.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.off =
Emitter.prototype.removeListener =
Emitter.prototype.removeAllListeners =
Emitter.prototype.removeEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};

  // all
  if (0 == arguments.length) {
    this._callbacks = {};
    return this;
  }

  // specific event
  var callbacks = this._callbacks['$' + event];
  if (!callbacks) return this;

  // remove all handlers
  if (1 == arguments.length) {
    delete this._callbacks['$' + event];
    return this;
  }

  // remove specific handler
  var cb;
  for (var i = 0; i < callbacks.length; i++) {
    cb = callbacks[i];
    if (cb === fn || cb.fn === fn) {
      callbacks.splice(i, 1);
      break;
    }
  }
  return this;
};

/**
 * Emit `event` with the given args.
 *
 * @param {String} event
 * @param {Mixed} ...
 * @return {Emitter}
 */

Emitter.prototype.emit = function(event){
  this._callbacks = this._callbacks || {};
  var args = [].slice.call(arguments, 1)
    , callbacks = this._callbacks['$' + event];

  if (callbacks) {
    callbacks = callbacks.slice(0);
    for (var i = 0, len = callbacks.length; i < len; ++i) {
      callbacks[i].apply(this, args);
    }
  }

  return this;
};

/**
 * Return array of callbacks for `event`.
 *
 * @param {String} event
 * @return {Array}
 * @api public
 */

Emitter.prototype.listeners = function(event){
  this._callbacks = this._callbacks || {};
  return this._callbacks['$' + event] || [];
};

/**
 * Check if this emitter has `event` handlers.
 *
 * @param {String} event
 * @return {Boolean}
 * @api public
 */

Emitter.prototype.hasListeners = function(event){
  return !! this.listeners(event).length;
};

},{}],41:[function(require,module,exports){

module.exports = function(a, b){
  var fn = function(){};
  fn.prototype = b.prototype;
  a.prototype = new fn;
  a.prototype.constructor = a;
};
},{}],42:[function(require,module,exports){
(function (process){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var BrowserInfo = /** @class */ (function () {
    function BrowserInfo(name, version, os) {
        this.name = name;
        this.version = version;
        this.os = os;
    }
    return BrowserInfo;
}());
exports.BrowserInfo = BrowserInfo;
var NodeInfo = /** @class */ (function () {
    function NodeInfo(version) {
        this.version = version;
        this.name = 'node';
        this.os = process.platform;
    }
    return NodeInfo;
}());
exports.NodeInfo = NodeInfo;
var BotInfo = /** @class */ (function () {
    function BotInfo() {
        this.bot = true; // NOTE: deprecated test name instead
        this.name = 'bot';
        this.version = null;
        this.os = null;
    }
    return BotInfo;
}());
exports.BotInfo = BotInfo;
// tslint:disable-next-line:max-line-length
var SEARCHBOX_UA_REGEX = /alexa|bot|crawl(er|ing)|facebookexternalhit|feedburner|google web preview|nagios|postrank|pingdom|slurp|spider|yahoo!|yandex/;
var SEARCHBOT_OS_REGEX = /(nuhk)|(Googlebot)|(Yammybot)|(Openbot)|(Slurp)|(MSNBot)|(Ask Jeeves\/Teoma)|(ia_archiver)/;
var REQUIRED_VERSION_PARTS = 3;
var userAgentRules = [
    ['aol', /AOLShield\/([0-9\._]+)/],
    ['edge', /Edge\/([0-9\._]+)/],
    ['yandexbrowser', /YaBrowser\/([0-9\._]+)/],
    ['vivaldi', /Vivaldi\/([0-9\.]+)/],
    ['kakaotalk', /KAKAOTALK\s([0-9\.]+)/],
    ['samsung', /SamsungBrowser\/([0-9\.]+)/],
    ['silk', /\bSilk\/([0-9._-]+)\b/],
    ['miui', /MiuiBrowser\/([0-9\.]+)$/],
    ['beaker', /BeakerBrowser\/([0-9\.]+)/],
    ['edge-chromium', /Edg\/([0-9\.]+)/],
    ['chrome', /(?!Chrom.*OPR)Chrom(?:e|ium)\/([0-9\.]+)(:?\s|$)/],
    ['phantomjs', /PhantomJS\/([0-9\.]+)(:?\s|$)/],
    ['crios', /CriOS\/([0-9\.]+)(:?\s|$)/],
    ['firefox', /Firefox\/([0-9\.]+)(?:\s|$)/],
    ['fxios', /FxiOS\/([0-9\.]+)/],
    ['opera-mini', /Opera Mini.*Version\/([0-9\.]+)/],
    ['opera', /Opera\/([0-9\.]+)(?:\s|$)/],
    ['opera', /OPR\/([0-9\.]+)(:?\s|$)$/],
    ['ie', /Trident\/7\.0.*rv\:([0-9\.]+).*\).*Gecko$/],
    ['ie', /MSIE\s([0-9\.]+);.*Trident\/[4-7].0/],
    ['ie', /MSIE\s(7\.0)/],
    ['bb10', /BB10;\sTouch.*Version\/([0-9\.]+)/],
    ['android', /Android\s([0-9\.]+)/],
    ['ios', /Version\/([0-9\._]+).*Mobile.*Safari.*/],
    ['safari', /Version\/([0-9\._]+).*Safari/],
    ['facebook', /FBAV\/([0-9\.]+)/],
    ['instagram', /Instagram\s([0-9\.]+)/],
    ['ios-webview', /AppleWebKit\/([0-9\.]+).*Mobile/],
    ['ios-webview', /AppleWebKit\/([0-9\.]+).*Gecko\)$/],
    ['searchbot', SEARCHBOX_UA_REGEX],
];
var operatingSystemRules = [
    ['iOS', /iP(hone|od|ad)/],
    ['Android OS', /Android/],
    ['BlackBerry OS', /BlackBerry|BB10/],
    ['Windows Mobile', /IEMobile/],
    ['Amazon OS', /Kindle/],
    ['Windows 3.11', /Win16/],
    ['Windows 95', /(Windows 95)|(Win95)|(Windows_95)/],
    ['Windows 98', /(Windows 98)|(Win98)/],
    ['Windows 2000', /(Windows NT 5.0)|(Windows 2000)/],
    ['Windows XP', /(Windows NT 5.1)|(Windows XP)/],
    ['Windows Server 2003', /(Windows NT 5.2)/],
    ['Windows Vista', /(Windows NT 6.0)/],
    ['Windows 7', /(Windows NT 6.1)/],
    ['Windows 8', /(Windows NT 6.2)/],
    ['Windows 8.1', /(Windows NT 6.3)/],
    ['Windows 10', /(Windows NT 10.0)/],
    ['Windows ME', /Windows ME/],
    ['Open BSD', /OpenBSD/],
    ['Sun OS', /SunOS/],
    ['Chrome OS', /CrOS/],
    ['Linux', /(Linux)|(X11)/],
    ['Mac OS', /(Mac_PowerPC)|(Macintosh)/],
    ['QNX', /QNX/],
    ['BeOS', /BeOS/],
    ['OS/2', /OS\/2/],
    ['Search Bot', SEARCHBOT_OS_REGEX],
];
function detect() {
    if (typeof navigator !== 'undefined') {
        return parseUserAgent(navigator.userAgent);
    }
    return getNodeVersion();
}
exports.detect = detect;
function parseUserAgent(ua) {
    // opted for using reduce here rather than Array#first with a regex.test call
    // this is primarily because using the reduce we only perform the regex
    // execution once rather than once for the test and for the exec again below
    // probably something that needs to be benchmarked though
    var matchedRule = ua !== '' &&
        userAgentRules.reduce(function (matched, _a) {
            var browser = _a[0], regex = _a[1];
            if (matched) {
                return matched;
            }
            var uaMatch = regex.exec(ua);
            return !!uaMatch && [browser, uaMatch];
        }, false);
    if (!matchedRule) {
        return null;
    }
    var name = matchedRule[0], match = matchedRule[1];
    if (name === 'searchbot') {
        return new BotInfo();
    }
    var versionParts = match[1] && match[1].split(/[._]/).slice(0, 3);
    if (versionParts) {
        if (versionParts.length < REQUIRED_VERSION_PARTS) {
            versionParts = versionParts.concat(createVersionParts(REQUIRED_VERSION_PARTS - versionParts.length));
        }
    }
    else {
        versionParts = [];
    }
    return new BrowserInfo(name, versionParts.join('.'), detectOS(ua));
}
exports.parseUserAgent = parseUserAgent;
function detectOS(ua) {
    for (var ii = 0, count = operatingSystemRules.length; ii < count; ii++) {
        var _a = operatingSystemRules[ii], os = _a[0], regex = _a[1];
        var match = regex.test(ua);
        if (match) {
            return os;
        }
    }
    return null;
}
exports.detectOS = detectOS;
function getNodeVersion() {
    var isNode = typeof process !== 'undefined' && process.version;
    return isNode ? new NodeInfo(process.version.slice(1)) : null;
}
exports.getNodeVersion = getNodeVersion;
function createVersionParts(count) {
    var output = [];
    for (var ii = 0; ii < count; ii++) {
        output.push('0');
    }
    return output;
}

}).call(this,require('_process'))
},{"_process":56}],43:[function(require,module,exports){
/**
 * Module dependencies.
 */

var keys = require('./keys');
var hasBinary = require('has-binary2');
var sliceBuffer = require('arraybuffer.slice');
var after = require('after');
var utf8 = require('./utf8');

var base64encoder;
if (typeof ArrayBuffer !== 'undefined') {
  base64encoder = require('base64-arraybuffer');
}

/**
 * Check if we are running an android browser. That requires us to use
 * ArrayBuffer with polling transports...
 *
 * http://ghinda.net/jpeg-blob-ajax-android/
 */

var isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/**
 * Check if we are running in PhantomJS.
 * Uploading a Blob with PhantomJS does not work correctly, as reported here:
 * https://github.com/ariya/phantomjs/issues/11395
 * @type boolean
 */
var isPhantomJS = typeof navigator !== 'undefined' && /PhantomJS/i.test(navigator.userAgent);

/**
 * When true, avoids using Blobs to encode payloads.
 * @type boolean
 */
var dontSendBlobs = isAndroid || isPhantomJS;

/**
 * Current protocol version.
 */

exports.protocol = 3;

/**
 * Packet types.
 */

var packets = exports.packets = {
    open:     0    // non-ws
  , close:    1    // non-ws
  , ping:     2
  , pong:     3
  , message:  4
  , upgrade:  5
  , noop:     6
};

var packetslist = keys(packets);

/**
 * Premade error packet.
 */

var err = { type: 'error', data: 'parser error' };

/**
 * Create a blob api even for blob builder when vendor prefixes exist
 */

var Blob = require('blob');

/**
 * Encodes a packet.
 *
 *     <packet type id> [ <data> ]
 *
 * Example:
 *
 *     5hello world
 *     3
 *     4
 *
 * Binary is encoded in an identical principle
 *
 * @api private
 */

exports.encodePacket = function (packet, supportsBinary, utf8encode, callback) {
  if (typeof supportsBinary === 'function') {
    callback = supportsBinary;
    supportsBinary = false;
  }

  if (typeof utf8encode === 'function') {
    callback = utf8encode;
    utf8encode = null;
  }

  var data = (packet.data === undefined)
    ? undefined
    : packet.data.buffer || packet.data;

  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
    return encodeArrayBuffer(packet, supportsBinary, callback);
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return encodeBlob(packet, supportsBinary, callback);
  }

  // might be an object with { base64: true, data: dataAsBase64String }
  if (data && data.base64) {
    return encodeBase64Object(packet, callback);
  }

  // Sending data as a utf-8 string
  var encoded = packets[packet.type];

  // data fragment is optional
  if (undefined !== packet.data) {
    encoded += utf8encode ? utf8.encode(String(packet.data), { strict: false }) : String(packet.data);
  }

  return callback('' + encoded);

};

function encodeBase64Object(packet, callback) {
  // packet data is an object { base64: true, data: dataAsBase64String }
  var message = 'b' + exports.packets[packet.type] + packet.data.data;
  return callback(message);
}

/**
 * Encode packet helpers for binary types
 */

function encodeArrayBuffer(packet, supportsBinary, callback) {
  if (!supportsBinary) {
    return exports.encodeBase64Packet(packet, callback);
  }

  var data = packet.data;
  var contentArray = new Uint8Array(data);
  var resultBuffer = new Uint8Array(1 + data.byteLength);

  resultBuffer[0] = packets[packet.type];
  for (var i = 0; i < contentArray.length; i++) {
    resultBuffer[i+1] = contentArray[i];
  }

  return callback(resultBuffer.buffer);
}

function encodeBlobAsArrayBuffer(packet, supportsBinary, callback) {
  if (!supportsBinary) {
    return exports.encodeBase64Packet(packet, callback);
  }

  var fr = new FileReader();
  fr.onload = function() {
    exports.encodePacket({ type: packet.type, data: fr.result }, supportsBinary, true, callback);
  };
  return fr.readAsArrayBuffer(packet.data);
}

function encodeBlob(packet, supportsBinary, callback) {
  if (!supportsBinary) {
    return exports.encodeBase64Packet(packet, callback);
  }

  if (dontSendBlobs) {
    return encodeBlobAsArrayBuffer(packet, supportsBinary, callback);
  }

  var length = new Uint8Array(1);
  length[0] = packets[packet.type];
  var blob = new Blob([length.buffer, packet.data]);

  return callback(blob);
}

/**
 * Encodes a packet with binary data in a base64 string
 *
 * @param {Object} packet, has `type` and `data`
 * @return {String} base64 encoded message
 */

exports.encodeBase64Packet = function(packet, callback) {
  var message = 'b' + exports.packets[packet.type];
  if (typeof Blob !== 'undefined' && packet.data instanceof Blob) {
    var fr = new FileReader();
    fr.onload = function() {
      var b64 = fr.result.split(',')[1];
      callback(message + b64);
    };
    return fr.readAsDataURL(packet.data);
  }

  var b64data;
  try {
    b64data = String.fromCharCode.apply(null, new Uint8Array(packet.data));
  } catch (e) {
    // iPhone Safari doesn't let you apply with typed arrays
    var typed = new Uint8Array(packet.data);
    var basic = new Array(typed.length);
    for (var i = 0; i < typed.length; i++) {
      basic[i] = typed[i];
    }
    b64data = String.fromCharCode.apply(null, basic);
  }
  message += btoa(b64data);
  return callback(message);
};

/**
 * Decodes a packet. Changes format to Blob if requested.
 *
 * @return {Object} with `type` and `data` (if any)
 * @api private
 */

exports.decodePacket = function (data, binaryType, utf8decode) {
  if (data === undefined) {
    return err;
  }
  // String data
  if (typeof data === 'string') {
    if (data.charAt(0) === 'b') {
      return exports.decodeBase64Packet(data.substr(1), binaryType);
    }

    if (utf8decode) {
      data = tryDecode(data);
      if (data === false) {
        return err;
      }
    }
    var type = data.charAt(0);

    if (Number(type) != type || !packetslist[type]) {
      return err;
    }

    if (data.length > 1) {
      return { type: packetslist[type], data: data.substring(1) };
    } else {
      return { type: packetslist[type] };
    }
  }

  var asArray = new Uint8Array(data);
  var type = asArray[0];
  var rest = sliceBuffer(data, 1);
  if (Blob && binaryType === 'blob') {
    rest = new Blob([rest]);
  }
  return { type: packetslist[type], data: rest };
};

function tryDecode(data) {
  try {
    data = utf8.decode(data, { strict: false });
  } catch (e) {
    return false;
  }
  return data;
}

/**
 * Decodes a packet encoded in a base64 string
 *
 * @param {String} base64 encoded message
 * @return {Object} with `type` and `data` (if any)
 */

exports.decodeBase64Packet = function(msg, binaryType) {
  var type = packetslist[msg.charAt(0)];
  if (!base64encoder) {
    return { type: type, data: { base64: true, data: msg.substr(1) } };
  }

  var data = base64encoder.decode(msg.substr(1));

  if (binaryType === 'blob' && Blob) {
    data = new Blob([data]);
  }

  return { type: type, data: data };
};

/**
 * Encodes multiple messages (payload).
 *
 *     <length>:data
 *
 * Example:
 *
 *     11:hello world2:hi
 *
 * If any contents are binary, they will be encoded as base64 strings. Base64
 * encoded strings are marked with a b before the length specifier
 *
 * @param {Array} packets
 * @api private
 */

exports.encodePayload = function (packets, supportsBinary, callback) {
  if (typeof supportsBinary === 'function') {
    callback = supportsBinary;
    supportsBinary = null;
  }

  var isBinary = hasBinary(packets);

  if (supportsBinary && isBinary) {
    if (Blob && !dontSendBlobs) {
      return exports.encodePayloadAsBlob(packets, callback);
    }

    return exports.encodePayloadAsArrayBuffer(packets, callback);
  }

  if (!packets.length) {
    return callback('0:');
  }

  function setLengthHeader(message) {
    return message.length + ':' + message;
  }

  function encodeOne(packet, doneCallback) {
    exports.encodePacket(packet, !isBinary ? false : supportsBinary, false, function(message) {
      doneCallback(null, setLengthHeader(message));
    });
  }

  map(packets, encodeOne, function(err, results) {
    return callback(results.join(''));
  });
};

/**
 * Async array map using after
 */

function map(ary, each, done) {
  var result = new Array(ary.length);
  var next = after(ary.length, done);

  var eachWithIndex = function(i, el, cb) {
    each(el, function(error, msg) {
      result[i] = msg;
      cb(error, result);
    });
  };

  for (var i = 0; i < ary.length; i++) {
    eachWithIndex(i, ary[i], next);
  }
}

/*
 * Decodes data when a payload is maybe expected. Possible binary contents are
 * decoded from their base64 representation
 *
 * @param {String} data, callback method
 * @api public
 */

exports.decodePayload = function (data, binaryType, callback) {
  if (typeof data !== 'string') {
    return exports.decodePayloadAsBinary(data, binaryType, callback);
  }

  if (typeof binaryType === 'function') {
    callback = binaryType;
    binaryType = null;
  }

  var packet;
  if (data === '') {
    // parser error - ignoring payload
    return callback(err, 0, 1);
  }

  var length = '', n, msg;

  for (var i = 0, l = data.length; i < l; i++) {
    var chr = data.charAt(i);

    if (chr !== ':') {
      length += chr;
      continue;
    }

    if (length === '' || (length != (n = Number(length)))) {
      // parser error - ignoring payload
      return callback(err, 0, 1);
    }

    msg = data.substr(i + 1, n);

    if (length != msg.length) {
      // parser error - ignoring payload
      return callback(err, 0, 1);
    }

    if (msg.length) {
      packet = exports.decodePacket(msg, binaryType, false);

      if (err.type === packet.type && err.data === packet.data) {
        // parser error in individual packet - ignoring payload
        return callback(err, 0, 1);
      }

      var ret = callback(packet, i + n, l);
      if (false === ret) return;
    }

    // advance cursor
    i += n;
    length = '';
  }

  if (length !== '') {
    // parser error - ignoring payload
    return callback(err, 0, 1);
  }

};

/**
 * Encodes multiple messages (payload) as binary.
 *
 * <1 = binary, 0 = string><number from 0-9><number from 0-9>[...]<number
 * 255><data>
 *
 * Example:
 * 1 3 255 1 2 3, if the binary contents are interpreted as 8 bit integers
 *
 * @param {Array} packets
 * @return {ArrayBuffer} encoded payload
 * @api private
 */

exports.encodePayloadAsArrayBuffer = function(packets, callback) {
  if (!packets.length) {
    return callback(new ArrayBuffer(0));
  }

  function encodeOne(packet, doneCallback) {
    exports.encodePacket(packet, true, true, function(data) {
      return doneCallback(null, data);
    });
  }

  map(packets, encodeOne, function(err, encodedPackets) {
    var totalLength = encodedPackets.reduce(function(acc, p) {
      var len;
      if (typeof p === 'string'){
        len = p.length;
      } else {
        len = p.byteLength;
      }
      return acc + len.toString().length + len + 2; // string/binary identifier + separator = 2
    }, 0);

    var resultArray = new Uint8Array(totalLength);

    var bufferIndex = 0;
    encodedPackets.forEach(function(p) {
      var isString = typeof p === 'string';
      var ab = p;
      if (isString) {
        var view = new Uint8Array(p.length);
        for (var i = 0; i < p.length; i++) {
          view[i] = p.charCodeAt(i);
        }
        ab = view.buffer;
      }

      if (isString) { // not true binary
        resultArray[bufferIndex++] = 0;
      } else { // true binary
        resultArray[bufferIndex++] = 1;
      }

      var lenStr = ab.byteLength.toString();
      for (var i = 0; i < lenStr.length; i++) {
        resultArray[bufferIndex++] = parseInt(lenStr[i]);
      }
      resultArray[bufferIndex++] = 255;

      var view = new Uint8Array(ab);
      for (var i = 0; i < view.length; i++) {
        resultArray[bufferIndex++] = view[i];
      }
    });

    return callback(resultArray.buffer);
  });
};

/**
 * Encode as Blob
 */

exports.encodePayloadAsBlob = function(packets, callback) {
  function encodeOne(packet, doneCallback) {
    exports.encodePacket(packet, true, true, function(encoded) {
      var binaryIdentifier = new Uint8Array(1);
      binaryIdentifier[0] = 1;
      if (typeof encoded === 'string') {
        var view = new Uint8Array(encoded.length);
        for (var i = 0; i < encoded.length; i++) {
          view[i] = encoded.charCodeAt(i);
        }
        encoded = view.buffer;
        binaryIdentifier[0] = 0;
      }

      var len = (encoded instanceof ArrayBuffer)
        ? encoded.byteLength
        : encoded.size;

      var lenStr = len.toString();
      var lengthAry = new Uint8Array(lenStr.length + 1);
      for (var i = 0; i < lenStr.length; i++) {
        lengthAry[i] = parseInt(lenStr[i]);
      }
      lengthAry[lenStr.length] = 255;

      if (Blob) {
        var blob = new Blob([binaryIdentifier.buffer, lengthAry.buffer, encoded]);
        doneCallback(null, blob);
      }
    });
  }

  map(packets, encodeOne, function(err, results) {
    return callback(new Blob(results));
  });
};

/*
 * Decodes data when a payload is maybe expected. Strings are decoded by
 * interpreting each byte as a key code for entries marked to start with 0. See
 * description of encodePayloadAsBinary
 *
 * @param {ArrayBuffer} data, callback method
 * @api public
 */

exports.decodePayloadAsBinary = function (data, binaryType, callback) {
  if (typeof binaryType === 'function') {
    callback = binaryType;
    binaryType = null;
  }

  var bufferTail = data;
  var buffers = [];

  while (bufferTail.byteLength > 0) {
    var tailArray = new Uint8Array(bufferTail);
    var isString = tailArray[0] === 0;
    var msgLength = '';

    for (var i = 1; ; i++) {
      if (tailArray[i] === 255) break;

      // 310 = char length of Number.MAX_VALUE
      if (msgLength.length > 310) {
        return callback(err, 0, 1);
      }

      msgLength += tailArray[i];
    }

    bufferTail = sliceBuffer(bufferTail, 2 + msgLength.length);
    msgLength = parseInt(msgLength);

    var msg = sliceBuffer(bufferTail, 0, msgLength);
    if (isString) {
      try {
        msg = String.fromCharCode.apply(null, new Uint8Array(msg));
      } catch (e) {
        // iPhone Safari doesn't let you apply to typed arrays
        var typed = new Uint8Array(msg);
        msg = '';
        for (var i = 0; i < typed.length; i++) {
          msg += String.fromCharCode(typed[i]);
        }
      }
    }

    buffers.push(msg);
    bufferTail = sliceBuffer(bufferTail, msgLength);
  }

  var total = buffers.length;
  buffers.forEach(function(buffer, i) {
    callback(exports.decodePacket(buffer, binaryType, true), i, total);
  });
};

},{"./keys":44,"./utf8":45,"after":31,"arraybuffer.slice":32,"base64-arraybuffer":34,"blob":36,"has-binary2":46}],44:[function(require,module,exports){

/**
 * Gets the keys for an object.
 *
 * @return {Array} keys
 * @api private
 */

module.exports = Object.keys || function keys (obj){
  var arr = [];
  var has = Object.prototype.hasOwnProperty;

  for (var i in obj) {
    if (has.call(obj, i)) {
      arr.push(i);
    }
  }
  return arr;
};

},{}],45:[function(require,module,exports){
/*! https://mths.be/utf8js v2.1.2 by @mathias */

var stringFromCharCode = String.fromCharCode;

// Taken from https://mths.be/punycode
function ucs2decode(string) {
	var output = [];
	var counter = 0;
	var length = string.length;
	var value;
	var extra;
	while (counter < length) {
		value = string.charCodeAt(counter++);
		if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
			// high surrogate, and there is a next character
			extra = string.charCodeAt(counter++);
			if ((extra & 0xFC00) == 0xDC00) { // low surrogate
				output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
			} else {
				// unmatched surrogate; only append this code unit, in case the next
				// code unit is the high surrogate of a surrogate pair
				output.push(value);
				counter--;
			}
		} else {
			output.push(value);
		}
	}
	return output;
}

// Taken from https://mths.be/punycode
function ucs2encode(array) {
	var length = array.length;
	var index = -1;
	var value;
	var output = '';
	while (++index < length) {
		value = array[index];
		if (value > 0xFFFF) {
			value -= 0x10000;
			output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
			value = 0xDC00 | value & 0x3FF;
		}
		output += stringFromCharCode(value);
	}
	return output;
}

function checkScalarValue(codePoint, strict) {
	if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
		if (strict) {
			throw Error(
				'Lone surrogate U+' + codePoint.toString(16).toUpperCase() +
				' is not a scalar value'
			);
		}
		return false;
	}
	return true;
}
/*--------------------------------------------------------------------------*/

function createByte(codePoint, shift) {
	return stringFromCharCode(((codePoint >> shift) & 0x3F) | 0x80);
}

function encodeCodePoint(codePoint, strict) {
	if ((codePoint & 0xFFFFFF80) == 0) { // 1-byte sequence
		return stringFromCharCode(codePoint);
	}
	var symbol = '';
	if ((codePoint & 0xFFFFF800) == 0) { // 2-byte sequence
		symbol = stringFromCharCode(((codePoint >> 6) & 0x1F) | 0xC0);
	}
	else if ((codePoint & 0xFFFF0000) == 0) { // 3-byte sequence
		if (!checkScalarValue(codePoint, strict)) {
			codePoint = 0xFFFD;
		}
		symbol = stringFromCharCode(((codePoint >> 12) & 0x0F) | 0xE0);
		symbol += createByte(codePoint, 6);
	}
	else if ((codePoint & 0xFFE00000) == 0) { // 4-byte sequence
		symbol = stringFromCharCode(((codePoint >> 18) & 0x07) | 0xF0);
		symbol += createByte(codePoint, 12);
		symbol += createByte(codePoint, 6);
	}
	symbol += stringFromCharCode((codePoint & 0x3F) | 0x80);
	return symbol;
}

function utf8encode(string, opts) {
	opts = opts || {};
	var strict = false !== opts.strict;

	var codePoints = ucs2decode(string);
	var length = codePoints.length;
	var index = -1;
	var codePoint;
	var byteString = '';
	while (++index < length) {
		codePoint = codePoints[index];
		byteString += encodeCodePoint(codePoint, strict);
	}
	return byteString;
}

/*--------------------------------------------------------------------------*/

function readContinuationByte() {
	if (byteIndex >= byteCount) {
		throw Error('Invalid byte index');
	}

	var continuationByte = byteArray[byteIndex] & 0xFF;
	byteIndex++;

	if ((continuationByte & 0xC0) == 0x80) {
		return continuationByte & 0x3F;
	}

	// If we end up here, it’s not a continuation byte
	throw Error('Invalid continuation byte');
}

function decodeSymbol(strict) {
	var byte1;
	var byte2;
	var byte3;
	var byte4;
	var codePoint;

	if (byteIndex > byteCount) {
		throw Error('Invalid byte index');
	}

	if (byteIndex == byteCount) {
		return false;
	}

	// Read first byte
	byte1 = byteArray[byteIndex] & 0xFF;
	byteIndex++;

	// 1-byte sequence (no continuation bytes)
	if ((byte1 & 0x80) == 0) {
		return byte1;
	}

	// 2-byte sequence
	if ((byte1 & 0xE0) == 0xC0) {
		byte2 = readContinuationByte();
		codePoint = ((byte1 & 0x1F) << 6) | byte2;
		if (codePoint >= 0x80) {
			return codePoint;
		} else {
			throw Error('Invalid continuation byte');
		}
	}

	// 3-byte sequence (may include unpaired surrogates)
	if ((byte1 & 0xF0) == 0xE0) {
		byte2 = readContinuationByte();
		byte3 = readContinuationByte();
		codePoint = ((byte1 & 0x0F) << 12) | (byte2 << 6) | byte3;
		if (codePoint >= 0x0800) {
			return checkScalarValue(codePoint, strict) ? codePoint : 0xFFFD;
		} else {
			throw Error('Invalid continuation byte');
		}
	}

	// 4-byte sequence
	if ((byte1 & 0xF8) == 0xF0) {
		byte2 = readContinuationByte();
		byte3 = readContinuationByte();
		byte4 = readContinuationByte();
		codePoint = ((byte1 & 0x07) << 0x12) | (byte2 << 0x0C) |
			(byte3 << 0x06) | byte4;
		if (codePoint >= 0x010000 && codePoint <= 0x10FFFF) {
			return codePoint;
		}
	}

	throw Error('Invalid UTF-8 detected');
}

var byteArray;
var byteCount;
var byteIndex;
function utf8decode(byteString, opts) {
	opts = opts || {};
	var strict = false !== opts.strict;

	byteArray = ucs2decode(byteString);
	byteCount = byteArray.length;
	byteIndex = 0;
	var codePoints = [];
	var tmp;
	while ((tmp = decodeSymbol(strict)) !== false) {
		codePoints.push(tmp);
	}
	return ucs2encode(codePoints);
}

module.exports = {
	version: '2.1.2',
	encode: utf8encode,
	decode: utf8decode
};

},{}],46:[function(require,module,exports){
(function (Buffer){
/* global Blob File */

/*
 * Module requirements.
 */

var isArray = require('isarray');

var toString = Object.prototype.toString;
var withNativeBlob = typeof Blob === 'function' ||
                        typeof Blob !== 'undefined' && toString.call(Blob) === '[object BlobConstructor]';
var withNativeFile = typeof File === 'function' ||
                        typeof File !== 'undefined' && toString.call(File) === '[object FileConstructor]';

/**
 * Module exports.
 */

module.exports = hasBinary;

/**
 * Checks for binary data.
 *
 * Supports Buffer, ArrayBuffer, Blob and File.
 *
 * @param {Object} anything
 * @api public
 */

function hasBinary (obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  if (isArray(obj)) {
    for (var i = 0, l = obj.length; i < l; i++) {
      if (hasBinary(obj[i])) {
        return true;
      }
    }
    return false;
  }

  if ((typeof Buffer === 'function' && Buffer.isBuffer && Buffer.isBuffer(obj)) ||
    (typeof ArrayBuffer === 'function' && obj instanceof ArrayBuffer) ||
    (withNativeBlob && obj instanceof Blob) ||
    (withNativeFile && obj instanceof File)
  ) {
    return true;
  }

  // see: https://github.com/Automattic/has-binary/pull/4
  if (obj.toJSON && typeof obj.toJSON === 'function' && arguments.length === 1) {
    return hasBinary(obj.toJSON(), true);
  }

  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && hasBinary(obj[key])) {
      return true;
    }
  }

  return false;
}

}).call(this,require("buffer").Buffer)
},{"buffer":38,"isarray":47}],47:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],48:[function(require,module,exports){

/**
 * Module exports.
 *
 * Logic borrowed from Modernizr:
 *
 *   - https://github.com/Modernizr/Modernizr/blob/master/feature-detects/cors.js
 */

try {
  module.exports = typeof XMLHttpRequest !== 'undefined' &&
    'withCredentials' in new XMLHttpRequest();
} catch (err) {
  // if XMLHttp support is disabled in IE then it will throw
  // when trying to create
  module.exports = false;
}

},{}],49:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],50:[function(require,module,exports){

var indexOf = [].indexOf;

module.exports = function(arr, obj){
  if (indexOf) return arr.indexOf(obj);
  for (var i = 0; i < arr.length; ++i) {
    if (arr[i] === obj) return i;
  }
  return -1;
};
},{}],51:[function(require,module,exports){
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.prefix = factory(root);
  }
}(this, function (root) {
  'use strict';

  var merge = function (target) {
    var i = 1;
    var length = arguments.length;
    var key;
    for (; i < length; i++) {
      for (key in arguments[i]) {
        if (Object.prototype.hasOwnProperty.call(arguments[i], key)) {
          target[key] = arguments[i][key];
        }
      }
    }
    return target;
  };

  var defaults = {
    template: '[%t] %l:',
    levelFormatter: function (level) {
      return level.toUpperCase();
    },
    nameFormatter: function (name) {
      return name || 'root';
    },
    timestampFormatter: function (date) {
      return date.toTimeString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, '$1');
    },
    format: undefined
  };

  var loglevel;
  var configs = {};

  var reg = function (rootLogger) {
    if (!rootLogger || !rootLogger.getLogger) {
      throw new TypeError('Argument is not a root logger');
    }
    loglevel = rootLogger;
  };

  var apply = function (logger, config) {
    if (!logger || !logger.setLevel) {
      throw new TypeError('Argument is not a logger');
    }

    /* eslint-disable vars-on-top */
    var originalFactory = logger.methodFactory;
    var name = logger.name || '';
    var parent = configs[name] || configs[''] || defaults;
    /* eslint-enable vars-on-top */

    function methodFactory(methodName, logLevel, loggerName) {
      var originalMethod = originalFactory(methodName, logLevel, loggerName);
      var options = configs[loggerName] || configs[''];

      var hasTimestamp = options.template.indexOf('%t') !== -1;
      var hasLevel = options.template.indexOf('%l') !== -1;
      var hasName = options.template.indexOf('%n') !== -1;

      return function () {
        var content = '';

        var length = arguments.length;
        var args = Array(length);
        var key = 0;
        for (; key < length; key++) {
          args[key] = arguments[key];
        }

        // skip the root method for child loggers to prevent duplicate logic
        if (name || !configs[loggerName]) {
          /* eslint-disable vars-on-top */
          var timestamp = options.timestampFormatter(new Date());
          var level = options.levelFormatter(methodName);
          var lname = options.nameFormatter(loggerName);
          /* eslint-enable vars-on-top */

          if (options.format) {
            content += options.format(level, lname, timestamp);
          } else {
            content += options.template;
            if (hasTimestamp) {
              content = content.replace(/%t/, timestamp);
            }
            if (hasLevel) content = content.replace(/%l/, level);
            if (hasName) content = content.replace(/%n/, lname);
          }

          if (args.length && typeof args[0] === 'string') {
            // concat prefix with first argument to support string substitutions
            args[0] = content + ' ' + args[0];
          } else {
            args.unshift(content);
          }
        }

        originalMethod.apply(undefined, args);
      };
    }

    if (!configs[name]) {
      logger.methodFactory = methodFactory;
    }

    // for remove inherited format option if template option preset
    config = config || {};
    if (config.template) config.format = undefined;

    configs[name] = merge({}, parent, config);

    logger.setLevel(logger.getLevel());

    if (!loglevel) {
      logger.warn(
        'It is necessary to call the function reg() of loglevel-plugin-prefix before calling apply. From the next release, it will throw an error. See more: https://github.com/kutuluk/loglevel-plugin-prefix/blob/master/README.md'
      );
    }

    return logger;
  };

  var api = {
    reg: reg,
    apply: apply
  };

  var save;

  if (root) {
    save = root.prefix;
    api.noConflict = function () {
      if (root.prefix === api) {
        root.prefix = save;
      }
      return api;
    };
  }

  return api;
}));

},{}],52:[function(require,module,exports){
/*
* loglevel - https://github.com/pimterry/loglevel
*
* Copyright (c) 2013 Tim Perry
* Licensed under the MIT license.
*/
(function (root, definition) {
    "use strict";
    if (typeof define === 'function' && define.amd) {
        define(definition);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = definition();
    } else {
        root.log = definition();
    }
}(this, function () {
    "use strict";

    // Slightly dubious tricks to cut down minimized file size
    var noop = function() {};
    var undefinedType = "undefined";

    var logMethods = [
        "trace",
        "debug",
        "info",
        "warn",
        "error"
    ];

    // Cross-browser bind equivalent that works at least back to IE6
    function bindMethod(obj, methodName) {
        var method = obj[methodName];
        if (typeof method.bind === 'function') {
            return method.bind(obj);
        } else {
            try {
                return Function.prototype.bind.call(method, obj);
            } catch (e) {
                // Missing bind shim or IE8 + Modernizr, fallback to wrapping
                return function() {
                    return Function.prototype.apply.apply(method, [obj, arguments]);
                };
            }
        }
    }

    // Build the best logging method possible for this env
    // Wherever possible we want to bind, not wrap, to preserve stack traces
    function realMethod(methodName) {
        if (methodName === 'debug') {
            methodName = 'log';
        }

        if (typeof console === undefinedType) {
            return false; // No method possible, for now - fixed later by enableLoggingWhenConsoleArrives
        } else if (console[methodName] !== undefined) {
            return bindMethod(console, methodName);
        } else if (console.log !== undefined) {
            return bindMethod(console, 'log');
        } else {
            return noop;
        }
    }

    // These private functions always need `this` to be set properly

    function replaceLoggingMethods(level, loggerName) {
        /*jshint validthis:true */
        for (var i = 0; i < logMethods.length; i++) {
            var methodName = logMethods[i];
            this[methodName] = (i < level) ?
                noop :
                this.methodFactory(methodName, level, loggerName);
        }

        // Define log.log as an alias for log.debug
        this.log = this.debug;
    }

    // In old IE versions, the console isn't present until you first open it.
    // We build realMethod() replacements here that regenerate logging methods
    function enableLoggingWhenConsoleArrives(methodName, level, loggerName) {
        return function () {
            if (typeof console !== undefinedType) {
                replaceLoggingMethods.call(this, level, loggerName);
                this[methodName].apply(this, arguments);
            }
        };
    }

    // By default, we use closely bound real methods wherever possible, and
    // otherwise we wait for a console to appear, and then try again.
    function defaultMethodFactory(methodName, level, loggerName) {
        /*jshint validthis:true */
        return realMethod(methodName) ||
               enableLoggingWhenConsoleArrives.apply(this, arguments);
    }

    function Logger(name, defaultLevel, factory) {
      var self = this;
      var currentLevel;
      var storageKey = "loglevel";
      if (name) {
        storageKey += ":" + name;
      }

      function persistLevelIfPossible(levelNum) {
          var levelName = (logMethods[levelNum] || 'silent').toUpperCase();

          if (typeof window === undefinedType) return;

          // Use localStorage if available
          try {
              window.localStorage[storageKey] = levelName;
              return;
          } catch (ignore) {}

          // Use session cookie as fallback
          try {
              window.document.cookie =
                encodeURIComponent(storageKey) + "=" + levelName + ";";
          } catch (ignore) {}
      }

      function getPersistedLevel() {
          var storedLevel;

          if (typeof window === undefinedType) return;

          try {
              storedLevel = window.localStorage[storageKey];
          } catch (ignore) {}

          // Fallback to cookies if local storage gives us nothing
          if (typeof storedLevel === undefinedType) {
              try {
                  var cookie = window.document.cookie;
                  var location = cookie.indexOf(
                      encodeURIComponent(storageKey) + "=");
                  if (location !== -1) {
                      storedLevel = /^([^;]+)/.exec(cookie.slice(location))[1];
                  }
              } catch (ignore) {}
          }

          // If the stored level is not valid, treat it as if nothing was stored.
          if (self.levels[storedLevel] === undefined) {
              storedLevel = undefined;
          }

          return storedLevel;
      }

      /*
       *
       * Public logger API - see https://github.com/pimterry/loglevel for details
       *
       */

      self.name = name;

      self.levels = { "TRACE": 0, "DEBUG": 1, "INFO": 2, "WARN": 3,
          "ERROR": 4, "SILENT": 5};

      self.methodFactory = factory || defaultMethodFactory;

      self.getLevel = function () {
          return currentLevel;
      };

      self.setLevel = function (level, persist) {
          if (typeof level === "string" && self.levels[level.toUpperCase()] !== undefined) {
              level = self.levels[level.toUpperCase()];
          }
          if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
              currentLevel = level;
              if (persist !== false) {  // defaults to true
                  persistLevelIfPossible(level);
              }
              replaceLoggingMethods.call(self, level, name);
              if (typeof console === undefinedType && level < self.levels.SILENT) {
                  return "No console available for logging";
              }
          } else {
              throw "log.setLevel() called with invalid level: " + level;
          }
      };

      self.setDefaultLevel = function (level) {
          if (!getPersistedLevel()) {
              self.setLevel(level, false);
          }
      };

      self.enableAll = function(persist) {
          self.setLevel(self.levels.TRACE, persist);
      };

      self.disableAll = function(persist) {
          self.setLevel(self.levels.SILENT, persist);
      };

      // Initialize with the right level
      var initialLevel = getPersistedLevel();
      if (initialLevel == null) {
          initialLevel = defaultLevel == null ? "WARN" : defaultLevel;
      }
      self.setLevel(initialLevel, false);
    }

    /*
     *
     * Top-level API
     *
     */

    var defaultLogger = new Logger();

    var _loggersByName = {};
    defaultLogger.getLogger = function getLogger(name) {
        if (typeof name !== "string" || name === "") {
          throw new TypeError("You must supply a name when creating a logger.");
        }

        var logger = _loggersByName[name];
        if (!logger) {
          logger = _loggersByName[name] = new Logger(
            name, defaultLogger.getLevel(), defaultLogger.methodFactory);
        }
        return logger;
    };

    // Grab the current global log variable in case of overwrite
    var _log = (typeof window !== undefinedType) ? window.log : undefined;
    defaultLogger.noConflict = function() {
        if (typeof window !== undefinedType &&
               window.log === defaultLogger) {
            window.log = _log;
        }

        return defaultLogger;
    };

    defaultLogger.getLoggers = function getLoggers() {
        return _loggersByName;
    };

    return defaultLogger;
}));

},{}],53:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],54:[function(require,module,exports){
/**
 * Compiles a querystring
 * Returns string representation of the object
 *
 * @param {Object}
 * @api private
 */

exports.encode = function (obj) {
  var str = '';

  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      if (str.length) str += '&';
      str += encodeURIComponent(i) + '=' + encodeURIComponent(obj[i]);
    }
  }

  return str;
};

/**
 * Parses a simple querystring into an object
 *
 * @param {String} qs
 * @api private
 */

exports.decode = function(qs){
  var qry = {};
  var pairs = qs.split('&');
  for (var i = 0, l = pairs.length; i < l; i++) {
    var pair = pairs[i].split('=');
    qry[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
  }
  return qry;
};

},{}],55:[function(require,module,exports){
/**
 * Parses an URI
 *
 * @author Steven Levithan <stevenlevithan.com> (MIT license)
 * @api private
 */

var re = /^(?:(?![^:@]+:[^:@\/]*@)(http|https|ws|wss):\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?((?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}|[^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

var parts = [
    'source', 'protocol', 'authority', 'userInfo', 'user', 'password', 'host', 'port', 'relative', 'path', 'directory', 'file', 'query', 'anchor'
];

module.exports = function parseuri(str) {
    var src = str,
        b = str.indexOf('['),
        e = str.indexOf(']');

    if (b != -1 && e != -1) {
        str = str.substring(0, b) + str.substring(b, e).replace(/:/g, ';') + str.substring(e, str.length);
    }

    var m = re.exec(str || ''),
        uri = {},
        i = 14;

    while (i--) {
        uri[parts[i]] = m[i] || '';
    }

    if (b != -1 && e != -1) {
        uri.source = src;
        uri.host = uri.host.substring(1, uri.host.length - 1).replace(/;/g, ':');
        uri.authority = uri.authority.replace('[', '').replace(']', '').replace(/;/g, ':');
        uri.ipv6uri = true;
    }

    return uri;
};

},{}],56:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],57:[function(require,module,exports){
/*
 *  Copyright (c) 2017 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
 /* eslint-env node */
'use strict';

var SDPUtils = require('sdp');

function fixStatsType(stat) {
  return {
    inboundrtp: 'inbound-rtp',
    outboundrtp: 'outbound-rtp',
    candidatepair: 'candidate-pair',
    localcandidate: 'local-candidate',
    remotecandidate: 'remote-candidate'
  }[stat.type] || stat.type;
}

function writeMediaSection(transceiver, caps, type, stream, dtlsRole) {
  var sdp = SDPUtils.writeRtpDescription(transceiver.kind, caps);

  // Map ICE parameters (ufrag, pwd) to SDP.
  sdp += SDPUtils.writeIceParameters(
      transceiver.iceGatherer.getLocalParameters());

  // Map DTLS parameters to SDP.
  sdp += SDPUtils.writeDtlsParameters(
      transceiver.dtlsTransport.getLocalParameters(),
      type === 'offer' ? 'actpass' : dtlsRole || 'active');

  sdp += 'a=mid:' + transceiver.mid + '\r\n';

  if (transceiver.rtpSender && transceiver.rtpReceiver) {
    sdp += 'a=sendrecv\r\n';
  } else if (transceiver.rtpSender) {
    sdp += 'a=sendonly\r\n';
  } else if (transceiver.rtpReceiver) {
    sdp += 'a=recvonly\r\n';
  } else {
    sdp += 'a=inactive\r\n';
  }

  if (transceiver.rtpSender) {
    var trackId = transceiver.rtpSender._initialTrackId ||
        transceiver.rtpSender.track.id;
    transceiver.rtpSender._initialTrackId = trackId;
    // spec.
    var msid = 'msid:' + (stream ? stream.id : '-') + ' ' +
        trackId + '\r\n';
    sdp += 'a=' + msid;
    // for Chrome. Legacy should no longer be required.
    sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].ssrc +
        ' ' + msid;

    // RTX
    if (transceiver.sendEncodingParameters[0].rtx) {
      sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].rtx.ssrc +
          ' ' + msid;
      sdp += 'a=ssrc-group:FID ' +
          transceiver.sendEncodingParameters[0].ssrc + ' ' +
          transceiver.sendEncodingParameters[0].rtx.ssrc +
          '\r\n';
    }
  }
  // FIXME: this should be written by writeRtpDescription.
  sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].ssrc +
      ' cname:' + SDPUtils.localCName + '\r\n';
  if (transceiver.rtpSender && transceiver.sendEncodingParameters[0].rtx) {
    sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].rtx.ssrc +
        ' cname:' + SDPUtils.localCName + '\r\n';
  }
  return sdp;
}

// Edge does not like
// 1) stun: filtered after 14393 unless ?transport=udp is present
// 2) turn: that does not have all of turn:host:port?transport=udp
// 3) turn: with ipv6 addresses
// 4) turn: occurring muliple times
function filterIceServers(iceServers, edgeVersion) {
  var hasTurn = false;
  iceServers = JSON.parse(JSON.stringify(iceServers));
  return iceServers.filter(function(server) {
    if (server && (server.urls || server.url)) {
      var urls = server.urls || server.url;
      if (server.url && !server.urls) {
        console.warn('RTCIceServer.url is deprecated! Use urls instead.');
      }
      var isString = typeof urls === 'string';
      if (isString) {
        urls = [urls];
      }
      urls = urls.filter(function(url) {
        var validTurn = url.indexOf('turn:') === 0 &&
            url.indexOf('transport=udp') !== -1 &&
            url.indexOf('turn:[') === -1 &&
            !hasTurn;

        if (validTurn) {
          hasTurn = true;
          return true;
        }
        return url.indexOf('stun:') === 0 && edgeVersion >= 14393 &&
            url.indexOf('?transport=udp') === -1;
      });

      delete server.url;
      server.urls = isString ? urls[0] : urls;
      return !!urls.length;
    }
  });
}

// Determines the intersection of local and remote capabilities.
function getCommonCapabilities(localCapabilities, remoteCapabilities) {
  var commonCapabilities = {
    codecs: [],
    headerExtensions: [],
    fecMechanisms: []
  };

  var findCodecByPayloadType = function(pt, codecs) {
    pt = parseInt(pt, 10);
    for (var i = 0; i < codecs.length; i++) {
      if (codecs[i].payloadType === pt ||
          codecs[i].preferredPayloadType === pt) {
        return codecs[i];
      }
    }
  };

  var rtxCapabilityMatches = function(lRtx, rRtx, lCodecs, rCodecs) {
    var lCodec = findCodecByPayloadType(lRtx.parameters.apt, lCodecs);
    var rCodec = findCodecByPayloadType(rRtx.parameters.apt, rCodecs);
    return lCodec && rCodec &&
        lCodec.name.toLowerCase() === rCodec.name.toLowerCase();
  };

  localCapabilities.codecs.forEach(function(lCodec) {
    for (var i = 0; i < remoteCapabilities.codecs.length; i++) {
      var rCodec = remoteCapabilities.codecs[i];
      if (lCodec.name.toLowerCase() === rCodec.name.toLowerCase() &&
          lCodec.clockRate === rCodec.clockRate) {
        if (lCodec.name.toLowerCase() === 'rtx' &&
            lCodec.parameters && rCodec.parameters.apt) {
          // for RTX we need to find the local rtx that has a apt
          // which points to the same local codec as the remote one.
          if (!rtxCapabilityMatches(lCodec, rCodec,
              localCapabilities.codecs, remoteCapabilities.codecs)) {
            continue;
          }
        }
        rCodec = JSON.parse(JSON.stringify(rCodec)); // deepcopy
        // number of channels is the highest common number of channels
        rCodec.numChannels = Math.min(lCodec.numChannels,
            rCodec.numChannels);
        // push rCodec so we reply with offerer payload type
        commonCapabilities.codecs.push(rCodec);

        // determine common feedback mechanisms
        rCodec.rtcpFeedback = rCodec.rtcpFeedback.filter(function(fb) {
          for (var j = 0; j < lCodec.rtcpFeedback.length; j++) {
            if (lCodec.rtcpFeedback[j].type === fb.type &&
                lCodec.rtcpFeedback[j].parameter === fb.parameter) {
              return true;
            }
          }
          return false;
        });
        // FIXME: also need to determine .parameters
        //  see https://github.com/openpeer/ortc/issues/569
        break;
      }
    }
  });

  localCapabilities.headerExtensions.forEach(function(lHeaderExtension) {
    for (var i = 0; i < remoteCapabilities.headerExtensions.length;
         i++) {
      var rHeaderExtension = remoteCapabilities.headerExtensions[i];
      if (lHeaderExtension.uri === rHeaderExtension.uri) {
        commonCapabilities.headerExtensions.push(rHeaderExtension);
        break;
      }
    }
  });

  // FIXME: fecMechanisms
  return commonCapabilities;
}

// is action=setLocalDescription with type allowed in signalingState
function isActionAllowedInSignalingState(action, type, signalingState) {
  return {
    offer: {
      setLocalDescription: ['stable', 'have-local-offer'],
      setRemoteDescription: ['stable', 'have-remote-offer']
    },
    answer: {
      setLocalDescription: ['have-remote-offer', 'have-local-pranswer'],
      setRemoteDescription: ['have-local-offer', 'have-remote-pranswer']
    }
  }[type][action].indexOf(signalingState) !== -1;
}

function maybeAddCandidate(iceTransport, candidate) {
  // Edge's internal representation adds some fields therefore
  // not all fieldѕ are taken into account.
  var alreadyAdded = iceTransport.getRemoteCandidates()
      .find(function(remoteCandidate) {
        return candidate.foundation === remoteCandidate.foundation &&
            candidate.ip === remoteCandidate.ip &&
            candidate.port === remoteCandidate.port &&
            candidate.priority === remoteCandidate.priority &&
            candidate.protocol === remoteCandidate.protocol &&
            candidate.type === remoteCandidate.type;
      });
  if (!alreadyAdded) {
    iceTransport.addRemoteCandidate(candidate);
  }
  return !alreadyAdded;
}


function makeError(name, description) {
  var e = new Error(description);
  e.name = name;
  // legacy error codes from https://heycam.github.io/webidl/#idl-DOMException-error-names
  e.code = {
    NotSupportedError: 9,
    InvalidStateError: 11,
    InvalidAccessError: 15,
    TypeError: undefined,
    OperationError: undefined
  }[name];
  return e;
}

module.exports = function(window, edgeVersion) {
  // https://w3c.github.io/mediacapture-main/#mediastream
  // Helper function to add the track to the stream and
  // dispatch the event ourselves.
  function addTrackToStreamAndFireEvent(track, stream) {
    stream.addTrack(track);
    stream.dispatchEvent(new window.MediaStreamTrackEvent('addtrack',
        {track: track}));
  }

  function removeTrackFromStreamAndFireEvent(track, stream) {
    stream.removeTrack(track);
    stream.dispatchEvent(new window.MediaStreamTrackEvent('removetrack',
        {track: track}));
  }

  function fireAddTrack(pc, track, receiver, streams) {
    var trackEvent = new Event('track');
    trackEvent.track = track;
    trackEvent.receiver = receiver;
    trackEvent.transceiver = {receiver: receiver};
    trackEvent.streams = streams;
    window.setTimeout(function() {
      pc._dispatchEvent('track', trackEvent);
    });
  }

  var RTCPeerConnection = function(config) {
    var pc = this;

    var _eventTarget = document.createDocumentFragment();
    ['addEventListener', 'removeEventListener', 'dispatchEvent']
        .forEach(function(method) {
          pc[method] = _eventTarget[method].bind(_eventTarget);
        });

    this.canTrickleIceCandidates = null;

    this.needNegotiation = false;

    this.localStreams = [];
    this.remoteStreams = [];

    this._localDescription = null;
    this._remoteDescription = null;

    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.iceGatheringState = 'new';

    config = JSON.parse(JSON.stringify(config || {}));

    this.usingBundle = config.bundlePolicy === 'max-bundle';
    if (config.rtcpMuxPolicy === 'negotiate') {
      throw(makeError('NotSupportedError',
          'rtcpMuxPolicy \'negotiate\' is not supported'));
    } else if (!config.rtcpMuxPolicy) {
      config.rtcpMuxPolicy = 'require';
    }

    switch (config.iceTransportPolicy) {
      case 'all':
      case 'relay':
        break;
      default:
        config.iceTransportPolicy = 'all';
        break;
    }

    switch (config.bundlePolicy) {
      case 'balanced':
      case 'max-compat':
      case 'max-bundle':
        break;
      default:
        config.bundlePolicy = 'balanced';
        break;
    }

    config.iceServers = filterIceServers(config.iceServers || [], edgeVersion);

    this._iceGatherers = [];
    if (config.iceCandidatePoolSize) {
      for (var i = config.iceCandidatePoolSize; i > 0; i--) {
        this._iceGatherers.push(new window.RTCIceGatherer({
          iceServers: config.iceServers,
          gatherPolicy: config.iceTransportPolicy
        }));
      }
    } else {
      config.iceCandidatePoolSize = 0;
    }

    this._config = config;

    // per-track iceGathers, iceTransports, dtlsTransports, rtpSenders, ...
    // everything that is needed to describe a SDP m-line.
    this.transceivers = [];

    this._sdpSessionId = SDPUtils.generateSessionId();
    this._sdpSessionVersion = 0;

    this._dtlsRole = undefined; // role for a=setup to use in answers.

    this._isClosed = false;
  };

  Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', {
    configurable: true,
    get: function() {
      return this._localDescription;
    }
  });
  Object.defineProperty(RTCPeerConnection.prototype, 'remoteDescription', {
    configurable: true,
    get: function() {
      return this._remoteDescription;
    }
  });

  // set up event handlers on prototype
  RTCPeerConnection.prototype.onicecandidate = null;
  RTCPeerConnection.prototype.onaddstream = null;
  RTCPeerConnection.prototype.ontrack = null;
  RTCPeerConnection.prototype.onremovestream = null;
  RTCPeerConnection.prototype.onsignalingstatechange = null;
  RTCPeerConnection.prototype.oniceconnectionstatechange = null;
  RTCPeerConnection.prototype.onconnectionstatechange = null;
  RTCPeerConnection.prototype.onicegatheringstatechange = null;
  RTCPeerConnection.prototype.onnegotiationneeded = null;
  RTCPeerConnection.prototype.ondatachannel = null;

  RTCPeerConnection.prototype._dispatchEvent = function(name, event) {
    if (this._isClosed) {
      return;
    }
    this.dispatchEvent(event);
    if (typeof this['on' + name] === 'function') {
      this['on' + name](event);
    }
  };

  RTCPeerConnection.prototype._emitGatheringStateChange = function() {
    var event = new Event('icegatheringstatechange');
    this._dispatchEvent('icegatheringstatechange', event);
  };

  RTCPeerConnection.prototype.getConfiguration = function() {
    return this._config;
  };

  RTCPeerConnection.prototype.getLocalStreams = function() {
    return this.localStreams;
  };

  RTCPeerConnection.prototype.getRemoteStreams = function() {
    return this.remoteStreams;
  };

  // internal helper to create a transceiver object.
  // (which is not yet the same as the WebRTC 1.0 transceiver)
  RTCPeerConnection.prototype._createTransceiver = function(kind, doNotAdd) {
    var hasBundleTransport = this.transceivers.length > 0;
    var transceiver = {
      track: null,
      iceGatherer: null,
      iceTransport: null,
      dtlsTransport: null,
      localCapabilities: null,
      remoteCapabilities: null,
      rtpSender: null,
      rtpReceiver: null,
      kind: kind,
      mid: null,
      sendEncodingParameters: null,
      recvEncodingParameters: null,
      stream: null,
      associatedRemoteMediaStreams: [],
      wantReceive: true
    };
    if (this.usingBundle && hasBundleTransport) {
      transceiver.iceTransport = this.transceivers[0].iceTransport;
      transceiver.dtlsTransport = this.transceivers[0].dtlsTransport;
    } else {
      var transports = this._createIceAndDtlsTransports();
      transceiver.iceTransport = transports.iceTransport;
      transceiver.dtlsTransport = transports.dtlsTransport;
    }
    if (!doNotAdd) {
      this.transceivers.push(transceiver);
    }
    return transceiver;
  };

  RTCPeerConnection.prototype.addTrack = function(track, stream) {
    if (this._isClosed) {
      throw makeError('InvalidStateError',
          'Attempted to call addTrack on a closed peerconnection.');
    }

    var alreadyExists = this.transceivers.find(function(s) {
      return s.track === track;
    });

    if (alreadyExists) {
      throw makeError('InvalidAccessError', 'Track already exists.');
    }

    var transceiver;
    for (var i = 0; i < this.transceivers.length; i++) {
      if (!this.transceivers[i].track &&
          this.transceivers[i].kind === track.kind) {
        transceiver = this.transceivers[i];
      }
    }
    if (!transceiver) {
      transceiver = this._createTransceiver(track.kind);
    }

    this._maybeFireNegotiationNeeded();

    if (this.localStreams.indexOf(stream) === -1) {
      this.localStreams.push(stream);
    }

    transceiver.track = track;
    transceiver.stream = stream;
    transceiver.rtpSender = new window.RTCRtpSender(track,
        transceiver.dtlsTransport);
    return transceiver.rtpSender;
  };

  RTCPeerConnection.prototype.addStream = function(stream) {
    var pc = this;
    if (edgeVersion >= 15025) {
      stream.getTracks().forEach(function(track) {
        pc.addTrack(track, stream);
      });
    } else {
      // Clone is necessary for local demos mostly, attaching directly
      // to two different senders does not work (build 10547).
      // Fixed in 15025 (or earlier)
      var clonedStream = stream.clone();
      stream.getTracks().forEach(function(track, idx) {
        var clonedTrack = clonedStream.getTracks()[idx];
        track.addEventListener('enabled', function(event) {
          clonedTrack.enabled = event.enabled;
        });
      });
      clonedStream.getTracks().forEach(function(track) {
        pc.addTrack(track, clonedStream);
      });
    }
  };

  RTCPeerConnection.prototype.removeTrack = function(sender) {
    if (this._isClosed) {
      throw makeError('InvalidStateError',
          'Attempted to call removeTrack on a closed peerconnection.');
    }

    if (!(sender instanceof window.RTCRtpSender)) {
      throw new TypeError('Argument 1 of RTCPeerConnection.removeTrack ' +
          'does not implement interface RTCRtpSender.');
    }

    var transceiver = this.transceivers.find(function(t) {
      return t.rtpSender === sender;
    });

    if (!transceiver) {
      throw makeError('InvalidAccessError',
          'Sender was not created by this connection.');
    }
    var stream = transceiver.stream;

    transceiver.rtpSender.stop();
    transceiver.rtpSender = null;
    transceiver.track = null;
    transceiver.stream = null;

    // remove the stream from the set of local streams
    var localStreams = this.transceivers.map(function(t) {
      return t.stream;
    });
    if (localStreams.indexOf(stream) === -1 &&
        this.localStreams.indexOf(stream) > -1) {
      this.localStreams.splice(this.localStreams.indexOf(stream), 1);
    }

    this._maybeFireNegotiationNeeded();
  };

  RTCPeerConnection.prototype.removeStream = function(stream) {
    var pc = this;
    stream.getTracks().forEach(function(track) {
      var sender = pc.getSenders().find(function(s) {
        return s.track === track;
      });
      if (sender) {
        pc.removeTrack(sender);
      }
    });
  };

  RTCPeerConnection.prototype.getSenders = function() {
    return this.transceivers.filter(function(transceiver) {
      return !!transceiver.rtpSender;
    })
    .map(function(transceiver) {
      return transceiver.rtpSender;
    });
  };

  RTCPeerConnection.prototype.getReceivers = function() {
    return this.transceivers.filter(function(transceiver) {
      return !!transceiver.rtpReceiver;
    })
    .map(function(transceiver) {
      return transceiver.rtpReceiver;
    });
  };


  RTCPeerConnection.prototype._createIceGatherer = function(sdpMLineIndex,
      usingBundle) {
    var pc = this;
    if (usingBundle && sdpMLineIndex > 0) {
      return this.transceivers[0].iceGatherer;
    } else if (this._iceGatherers.length) {
      return this._iceGatherers.shift();
    }
    var iceGatherer = new window.RTCIceGatherer({
      iceServers: this._config.iceServers,
      gatherPolicy: this._config.iceTransportPolicy
    });
    Object.defineProperty(iceGatherer, 'state',
        {value: 'new', writable: true}
    );

    this.transceivers[sdpMLineIndex].bufferedCandidateEvents = [];
    this.transceivers[sdpMLineIndex].bufferCandidates = function(event) {
      var end = !event.candidate || Object.keys(event.candidate).length === 0;
      // polyfill since RTCIceGatherer.state is not implemented in
      // Edge 10547 yet.
      iceGatherer.state = end ? 'completed' : 'gathering';
      if (pc.transceivers[sdpMLineIndex].bufferedCandidateEvents !== null) {
        pc.transceivers[sdpMLineIndex].bufferedCandidateEvents.push(event);
      }
    };
    iceGatherer.addEventListener('localcandidate',
      this.transceivers[sdpMLineIndex].bufferCandidates);
    return iceGatherer;
  };

  // start gathering from an RTCIceGatherer.
  RTCPeerConnection.prototype._gather = function(mid, sdpMLineIndex) {
    var pc = this;
    var iceGatherer = this.transceivers[sdpMLineIndex].iceGatherer;
    if (iceGatherer.onlocalcandidate) {
      return;
    }
    var bufferedCandidateEvents =
      this.transceivers[sdpMLineIndex].bufferedCandidateEvents;
    this.transceivers[sdpMLineIndex].bufferedCandidateEvents = null;
    iceGatherer.removeEventListener('localcandidate',
      this.transceivers[sdpMLineIndex].bufferCandidates);
    iceGatherer.onlocalcandidate = function(evt) {
      if (pc.usingBundle && sdpMLineIndex > 0) {
        // if we know that we use bundle we can drop candidates with
        // ѕdpMLineIndex > 0. If we don't do this then our state gets
        // confused since we dispose the extra ice gatherer.
        return;
      }
      var event = new Event('icecandidate');
      event.candidate = {sdpMid: mid, sdpMLineIndex: sdpMLineIndex};

      var cand = evt.candidate;
      // Edge emits an empty object for RTCIceCandidateComplete‥
      var end = !cand || Object.keys(cand).length === 0;
      if (end) {
        // polyfill since RTCIceGatherer.state is not implemented in
        // Edge 10547 yet.
        if (iceGatherer.state === 'new' || iceGatherer.state === 'gathering') {
          iceGatherer.state = 'completed';
        }
      } else {
        if (iceGatherer.state === 'new') {
          iceGatherer.state = 'gathering';
        }
        // RTCIceCandidate doesn't have a component, needs to be added
        cand.component = 1;
        // also the usernameFragment. TODO: update SDP to take both variants.
        cand.ufrag = iceGatherer.getLocalParameters().usernameFragment;

        var serializedCandidate = SDPUtils.writeCandidate(cand);
        event.candidate = Object.assign(event.candidate,
            SDPUtils.parseCandidate(serializedCandidate));

        event.candidate.candidate = serializedCandidate;
        event.candidate.toJSON = function() {
          return {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment
          };
        };
      }

      // update local description.
      var sections = SDPUtils.getMediaSections(pc._localDescription.sdp);
      if (!end) {
        sections[event.candidate.sdpMLineIndex] +=
            'a=' + event.candidate.candidate + '\r\n';
      } else {
        sections[event.candidate.sdpMLineIndex] +=
            'a=end-of-candidates\r\n';
      }
      pc._localDescription.sdp =
          SDPUtils.getDescription(pc._localDescription.sdp) +
          sections.join('');
      var complete = pc.transceivers.every(function(transceiver) {
        return transceiver.iceGatherer &&
            transceiver.iceGatherer.state === 'completed';
      });

      if (pc.iceGatheringState !== 'gathering') {
        pc.iceGatheringState = 'gathering';
        pc._emitGatheringStateChange();
      }

      // Emit candidate. Also emit null candidate when all gatherers are
      // complete.
      if (!end) {
        pc._dispatchEvent('icecandidate', event);
      }
      if (complete) {
        pc._dispatchEvent('icecandidate', new Event('icecandidate'));
        pc.iceGatheringState = 'complete';
        pc._emitGatheringStateChange();
      }
    };

    // emit already gathered candidates.
    window.setTimeout(function() {
      bufferedCandidateEvents.forEach(function(e) {
        iceGatherer.onlocalcandidate(e);
      });
    }, 0);
  };

  // Create ICE transport and DTLS transport.
  RTCPeerConnection.prototype._createIceAndDtlsTransports = function() {
    var pc = this;
    var iceTransport = new window.RTCIceTransport(null);
    iceTransport.onicestatechange = function() {
      pc._updateIceConnectionState();
      pc._updateConnectionState();
    };

    var dtlsTransport = new window.RTCDtlsTransport(iceTransport);
    dtlsTransport.ondtlsstatechange = function() {
      pc._updateConnectionState();
    };
    dtlsTransport.onerror = function() {
      // onerror does not set state to failed by itself.
      Object.defineProperty(dtlsTransport, 'state',
          {value: 'failed', writable: true});
      pc._updateConnectionState();
    };

    return {
      iceTransport: iceTransport,
      dtlsTransport: dtlsTransport
    };
  };

  // Destroy ICE gatherer, ICE transport and DTLS transport.
  // Without triggering the callbacks.
  RTCPeerConnection.prototype._disposeIceAndDtlsTransports = function(
      sdpMLineIndex) {
    var iceGatherer = this.transceivers[sdpMLineIndex].iceGatherer;
    if (iceGatherer) {
      delete iceGatherer.onlocalcandidate;
      delete this.transceivers[sdpMLineIndex].iceGatherer;
    }
    var iceTransport = this.transceivers[sdpMLineIndex].iceTransport;
    if (iceTransport) {
      delete iceTransport.onicestatechange;
      delete this.transceivers[sdpMLineIndex].iceTransport;
    }
    var dtlsTransport = this.transceivers[sdpMLineIndex].dtlsTransport;
    if (dtlsTransport) {
      delete dtlsTransport.ondtlsstatechange;
      delete dtlsTransport.onerror;
      delete this.transceivers[sdpMLineIndex].dtlsTransport;
    }
  };

  // Start the RTP Sender and Receiver for a transceiver.
  RTCPeerConnection.prototype._transceive = function(transceiver,
      send, recv) {
    var params = getCommonCapabilities(transceiver.localCapabilities,
        transceiver.remoteCapabilities);
    if (send && transceiver.rtpSender) {
      params.encodings = transceiver.sendEncodingParameters;
      params.rtcp = {
        cname: SDPUtils.localCName,
        compound: transceiver.rtcpParameters.compound
      };
      if (transceiver.recvEncodingParameters.length) {
        params.rtcp.ssrc = transceiver.recvEncodingParameters[0].ssrc;
      }
      transceiver.rtpSender.send(params);
    }
    if (recv && transceiver.rtpReceiver && params.codecs.length > 0) {
      // remove RTX field in Edge 14942
      if (transceiver.kind === 'video'
          && transceiver.recvEncodingParameters
          && edgeVersion < 15019) {
        transceiver.recvEncodingParameters.forEach(function(p) {
          delete p.rtx;
        });
      }
      if (transceiver.recvEncodingParameters.length) {
        params.encodings = transceiver.recvEncodingParameters;
      } else {
        params.encodings = [{}];
      }
      params.rtcp = {
        compound: transceiver.rtcpParameters.compound
      };
      if (transceiver.rtcpParameters.cname) {
        params.rtcp.cname = transceiver.rtcpParameters.cname;
      }
      if (transceiver.sendEncodingParameters.length) {
        params.rtcp.ssrc = transceiver.sendEncodingParameters[0].ssrc;
      }
      transceiver.rtpReceiver.receive(params);
    }
  };

  RTCPeerConnection.prototype.setLocalDescription = function(description) {
    var pc = this;

    // Note: pranswer is not supported.
    if (['offer', 'answer'].indexOf(description.type) === -1) {
      return Promise.reject(makeError('TypeError',
          'Unsupported type "' + description.type + '"'));
    }

    if (!isActionAllowedInSignalingState('setLocalDescription',
        description.type, pc.signalingState) || pc._isClosed) {
      return Promise.reject(makeError('InvalidStateError',
          'Can not set local ' + description.type +
          ' in state ' + pc.signalingState));
    }

    var sections;
    var sessionpart;
    if (description.type === 'offer') {
      // VERY limited support for SDP munging. Limited to:
      // * changing the order of codecs
      sections = SDPUtils.splitSections(description.sdp);
      sessionpart = sections.shift();
      sections.forEach(function(mediaSection, sdpMLineIndex) {
        var caps = SDPUtils.parseRtpParameters(mediaSection);
        pc.transceivers[sdpMLineIndex].localCapabilities = caps;
      });

      pc.transceivers.forEach(function(transceiver, sdpMLineIndex) {
        pc._gather(transceiver.mid, sdpMLineIndex);
      });
    } else if (description.type === 'answer') {
      sections = SDPUtils.splitSections(pc._remoteDescription.sdp);
      sessionpart = sections.shift();
      var isIceLite = SDPUtils.matchPrefix(sessionpart,
          'a=ice-lite').length > 0;
      sections.forEach(function(mediaSection, sdpMLineIndex) {
        var transceiver = pc.transceivers[sdpMLineIndex];
        var iceGatherer = transceiver.iceGatherer;
        var iceTransport = transceiver.iceTransport;
        var dtlsTransport = transceiver.dtlsTransport;
        var localCapabilities = transceiver.localCapabilities;
        var remoteCapabilities = transceiver.remoteCapabilities;

        // treat bundle-only as not-rejected.
        var rejected = SDPUtils.isRejected(mediaSection) &&
            SDPUtils.matchPrefix(mediaSection, 'a=bundle-only').length === 0;

        if (!rejected && !transceiver.rejected) {
          var remoteIceParameters = SDPUtils.getIceParameters(
              mediaSection, sessionpart);
          var remoteDtlsParameters = SDPUtils.getDtlsParameters(
              mediaSection, sessionpart);
          if (isIceLite) {
            remoteDtlsParameters.role = 'server';
          }

          if (!pc.usingBundle || sdpMLineIndex === 0) {
            pc._gather(transceiver.mid, sdpMLineIndex);
            if (iceTransport.state === 'new') {
              iceTransport.start(iceGatherer, remoteIceParameters,
                  isIceLite ? 'controlling' : 'controlled');
            }
            if (dtlsTransport.state === 'new') {
              dtlsTransport.start(remoteDtlsParameters);
            }
          }

          // Calculate intersection of capabilities.
          var params = getCommonCapabilities(localCapabilities,
              remoteCapabilities);

          // Start the RTCRtpSender. The RTCRtpReceiver for this
          // transceiver has already been started in setRemoteDescription.
          pc._transceive(transceiver,
              params.codecs.length > 0,
              false);
        }
      });
    }

    pc._localDescription = {
      type: description.type,
      sdp: description.sdp
    };
    if (description.type === 'offer') {
      pc._updateSignalingState('have-local-offer');
    } else {
      pc._updateSignalingState('stable');
    }

    return Promise.resolve();
  };

  RTCPeerConnection.prototype.setRemoteDescription = function(description) {
    var pc = this;

    // Note: pranswer is not supported.
    if (['offer', 'answer'].indexOf(description.type) === -1) {
      return Promise.reject(makeError('TypeError',
          'Unsupported type "' + description.type + '"'));
    }

    if (!isActionAllowedInSignalingState('setRemoteDescription',
        description.type, pc.signalingState) || pc._isClosed) {
      return Promise.reject(makeError('InvalidStateError',
          'Can not set remote ' + description.type +
          ' in state ' + pc.signalingState));
    }

    var streams = {};
    pc.remoteStreams.forEach(function(stream) {
      streams[stream.id] = stream;
    });
    var receiverList = [];
    var sections = SDPUtils.splitSections(description.sdp);
    var sessionpart = sections.shift();
    var isIceLite = SDPUtils.matchPrefix(sessionpart,
        'a=ice-lite').length > 0;
    var usingBundle = SDPUtils.matchPrefix(sessionpart,
        'a=group:BUNDLE ').length > 0;
    pc.usingBundle = usingBundle;
    var iceOptions = SDPUtils.matchPrefix(sessionpart,
        'a=ice-options:')[0];
    if (iceOptions) {
      pc.canTrickleIceCandidates = iceOptions.substr(14).split(' ')
          .indexOf('trickle') >= 0;
    } else {
      pc.canTrickleIceCandidates = false;
    }

    sections.forEach(function(mediaSection, sdpMLineIndex) {
      var lines = SDPUtils.splitLines(mediaSection);
      var kind = SDPUtils.getKind(mediaSection);
      // treat bundle-only as not-rejected.
      var rejected = SDPUtils.isRejected(mediaSection) &&
          SDPUtils.matchPrefix(mediaSection, 'a=bundle-only').length === 0;
      var protocol = lines[0].substr(2).split(' ')[2];

      var direction = SDPUtils.getDirection(mediaSection, sessionpart);
      var remoteMsid = SDPUtils.parseMsid(mediaSection);

      var mid = SDPUtils.getMid(mediaSection) || SDPUtils.generateIdentifier();

      // Reject datachannels which are not implemented yet.
      if (rejected || (kind === 'application' && (protocol === 'DTLS/SCTP' ||
          protocol === 'UDP/DTLS/SCTP'))) {
        // TODO: this is dangerous in the case where a non-rejected m-line
        //     becomes rejected.
        pc.transceivers[sdpMLineIndex] = {
          mid: mid,
          kind: kind,
          protocol: protocol,
          rejected: true
        };
        return;
      }

      if (!rejected && pc.transceivers[sdpMLineIndex] &&
          pc.transceivers[sdpMLineIndex].rejected) {
        // recycle a rejected transceiver.
        pc.transceivers[sdpMLineIndex] = pc._createTransceiver(kind, true);
      }

      var transceiver;
      var iceGatherer;
      var iceTransport;
      var dtlsTransport;
      var rtpReceiver;
      var sendEncodingParameters;
      var recvEncodingParameters;
      var localCapabilities;

      var track;
      // FIXME: ensure the mediaSection has rtcp-mux set.
      var remoteCapabilities = SDPUtils.parseRtpParameters(mediaSection);
      var remoteIceParameters;
      var remoteDtlsParameters;
      if (!rejected) {
        remoteIceParameters = SDPUtils.getIceParameters(mediaSection,
            sessionpart);
        remoteDtlsParameters = SDPUtils.getDtlsParameters(mediaSection,
            sessionpart);
        remoteDtlsParameters.role = 'client';
      }
      recvEncodingParameters =
          SDPUtils.parseRtpEncodingParameters(mediaSection);

      var rtcpParameters = SDPUtils.parseRtcpParameters(mediaSection);

      var isComplete = SDPUtils.matchPrefix(mediaSection,
          'a=end-of-candidates', sessionpart).length > 0;
      var cands = SDPUtils.matchPrefix(mediaSection, 'a=candidate:')
          .map(function(cand) {
            return SDPUtils.parseCandidate(cand);
          })
          .filter(function(cand) {
            return cand.component === 1;
          });

      // Check if we can use BUNDLE and dispose transports.
      if ((description.type === 'offer' || description.type === 'answer') &&
          !rejected && usingBundle && sdpMLineIndex > 0 &&
          pc.transceivers[sdpMLineIndex]) {
        pc._disposeIceAndDtlsTransports(sdpMLineIndex);
        pc.transceivers[sdpMLineIndex].iceGatherer =
            pc.transceivers[0].iceGatherer;
        pc.transceivers[sdpMLineIndex].iceTransport =
            pc.transceivers[0].iceTransport;
        pc.transceivers[sdpMLineIndex].dtlsTransport =
            pc.transceivers[0].dtlsTransport;
        if (pc.transceivers[sdpMLineIndex].rtpSender) {
          pc.transceivers[sdpMLineIndex].rtpSender.setTransport(
              pc.transceivers[0].dtlsTransport);
        }
        if (pc.transceivers[sdpMLineIndex].rtpReceiver) {
          pc.transceivers[sdpMLineIndex].rtpReceiver.setTransport(
              pc.transceivers[0].dtlsTransport);
        }
      }
      if (description.type === 'offer' && !rejected) {
        transceiver = pc.transceivers[sdpMLineIndex] ||
            pc._createTransceiver(kind);
        transceiver.mid = mid;

        if (!transceiver.iceGatherer) {
          transceiver.iceGatherer = pc._createIceGatherer(sdpMLineIndex,
              usingBundle);
        }

        if (cands.length && transceiver.iceTransport.state === 'new') {
          if (isComplete && (!usingBundle || sdpMLineIndex === 0)) {
            transceiver.iceTransport.setRemoteCandidates(cands);
          } else {
            cands.forEach(function(candidate) {
              maybeAddCandidate(transceiver.iceTransport, candidate);
            });
          }
        }

        localCapabilities = window.RTCRtpReceiver.getCapabilities(kind);

        // filter RTX until additional stuff needed for RTX is implemented
        // in adapter.js
        if (edgeVersion < 15019) {
          localCapabilities.codecs = localCapabilities.codecs.filter(
              function(codec) {
                return codec.name !== 'rtx';
              });
        }

        sendEncodingParameters = transceiver.sendEncodingParameters || [{
          ssrc: (2 * sdpMLineIndex + 2) * 1001
        }];

        // TODO: rewrite to use http://w3c.github.io/webrtc-pc/#set-associated-remote-streams
        var isNewTrack = false;
        if (direction === 'sendrecv' || direction === 'sendonly') {
          isNewTrack = !transceiver.rtpReceiver;
          rtpReceiver = transceiver.rtpReceiver ||
              new window.RTCRtpReceiver(transceiver.dtlsTransport, kind);

          if (isNewTrack) {
            var stream;
            track = rtpReceiver.track;
            // FIXME: does not work with Plan B.
            if (remoteMsid && remoteMsid.stream === '-') {
              // no-op. a stream id of '-' means: no associated stream.
            } else if (remoteMsid) {
              if (!streams[remoteMsid.stream]) {
                streams[remoteMsid.stream] = new window.MediaStream();
                Object.defineProperty(streams[remoteMsid.stream], 'id', {
                  get: function() {
                    return remoteMsid.stream;
                  }
                });
              }
              Object.defineProperty(track, 'id', {
                get: function() {
                  return remoteMsid.track;
                }
              });
              stream = streams[remoteMsid.stream];
            } else {
              if (!streams.default) {
                streams.default = new window.MediaStream();
              }
              stream = streams.default;
            }
            if (stream) {
              addTrackToStreamAndFireEvent(track, stream);
              transceiver.associatedRemoteMediaStreams.push(stream);
            }
            receiverList.push([track, rtpReceiver, stream]);
          }
        } else if (transceiver.rtpReceiver && transceiver.rtpReceiver.track) {
          transceiver.associatedRemoteMediaStreams.forEach(function(s) {
            var nativeTrack = s.getTracks().find(function(t) {
              return t.id === transceiver.rtpReceiver.track.id;
            });
            if (nativeTrack) {
              removeTrackFromStreamAndFireEvent(nativeTrack, s);
            }
          });
          transceiver.associatedRemoteMediaStreams = [];
        }

        transceiver.localCapabilities = localCapabilities;
        transceiver.remoteCapabilities = remoteCapabilities;
        transceiver.rtpReceiver = rtpReceiver;
        transceiver.rtcpParameters = rtcpParameters;
        transceiver.sendEncodingParameters = sendEncodingParameters;
        transceiver.recvEncodingParameters = recvEncodingParameters;

        // Start the RTCRtpReceiver now. The RTPSender is started in
        // setLocalDescription.
        pc._transceive(pc.transceivers[sdpMLineIndex],
            false,
            isNewTrack);
      } else if (description.type === 'answer' && !rejected) {
        transceiver = pc.transceivers[sdpMLineIndex];
        iceGatherer = transceiver.iceGatherer;
        iceTransport = transceiver.iceTransport;
        dtlsTransport = transceiver.dtlsTransport;
        rtpReceiver = transceiver.rtpReceiver;
        sendEncodingParameters = transceiver.sendEncodingParameters;
        localCapabilities = transceiver.localCapabilities;

        pc.transceivers[sdpMLineIndex].recvEncodingParameters =
            recvEncodingParameters;
        pc.transceivers[sdpMLineIndex].remoteCapabilities =
            remoteCapabilities;
        pc.transceivers[sdpMLineIndex].rtcpParameters = rtcpParameters;

        if (cands.length && iceTransport.state === 'new') {
          if ((isIceLite || isComplete) &&
              (!usingBundle || sdpMLineIndex === 0)) {
            iceTransport.setRemoteCandidates(cands);
          } else {
            cands.forEach(function(candidate) {
              maybeAddCandidate(transceiver.iceTransport, candidate);
            });
          }
        }

        if (!usingBundle || sdpMLineIndex === 0) {
          if (iceTransport.state === 'new') {
            iceTransport.start(iceGatherer, remoteIceParameters,
                'controlling');
          }
          if (dtlsTransport.state === 'new') {
            dtlsTransport.start(remoteDtlsParameters);
          }
        }

        // If the offer contained RTX but the answer did not,
        // remove RTX from sendEncodingParameters.
        var commonCapabilities = getCommonCapabilities(
          transceiver.localCapabilities,
          transceiver.remoteCapabilities);

        var hasRtx = commonCapabilities.codecs.filter(function(c) {
          return c.name.toLowerCase() === 'rtx';
        }).length;
        if (!hasRtx && transceiver.sendEncodingParameters[0].rtx) {
          delete transceiver.sendEncodingParameters[0].rtx;
        }

        pc._transceive(transceiver,
            direction === 'sendrecv' || direction === 'recvonly',
            direction === 'sendrecv' || direction === 'sendonly');

        // TODO: rewrite to use http://w3c.github.io/webrtc-pc/#set-associated-remote-streams
        if (rtpReceiver &&
            (direction === 'sendrecv' || direction === 'sendonly')) {
          track = rtpReceiver.track;
          if (remoteMsid) {
            if (!streams[remoteMsid.stream]) {
              streams[remoteMsid.stream] = new window.MediaStream();
            }
            addTrackToStreamAndFireEvent(track, streams[remoteMsid.stream]);
            receiverList.push([track, rtpReceiver, streams[remoteMsid.stream]]);
          } else {
            if (!streams.default) {
              streams.default = new window.MediaStream();
            }
            addTrackToStreamAndFireEvent(track, streams.default);
            receiverList.push([track, rtpReceiver, streams.default]);
          }
        } else {
          // FIXME: actually the receiver should be created later.
          delete transceiver.rtpReceiver;
        }
      }
    });

    if (pc._dtlsRole === undefined) {
      pc._dtlsRole = description.type === 'offer' ? 'active' : 'passive';
    }

    pc._remoteDescription = {
      type: description.type,
      sdp: description.sdp
    };
    if (description.type === 'offer') {
      pc._updateSignalingState('have-remote-offer');
    } else {
      pc._updateSignalingState('stable');
    }
    Object.keys(streams).forEach(function(sid) {
      var stream = streams[sid];
      if (stream.getTracks().length) {
        if (pc.remoteStreams.indexOf(stream) === -1) {
          pc.remoteStreams.push(stream);
          var event = new Event('addstream');
          event.stream = stream;
          window.setTimeout(function() {
            pc._dispatchEvent('addstream', event);
          });
        }

        receiverList.forEach(function(item) {
          var track = item[0];
          var receiver = item[1];
          if (stream.id !== item[2].id) {
            return;
          }
          fireAddTrack(pc, track, receiver, [stream]);
        });
      }
    });
    receiverList.forEach(function(item) {
      if (item[2]) {
        return;
      }
      fireAddTrack(pc, item[0], item[1], []);
    });

    // check whether addIceCandidate({}) was called within four seconds after
    // setRemoteDescription.
    window.setTimeout(function() {
      if (!(pc && pc.transceivers)) {
        return;
      }
      pc.transceivers.forEach(function(transceiver) {
        if (transceiver.iceTransport &&
            transceiver.iceTransport.state === 'new' &&
            transceiver.iceTransport.getRemoteCandidates().length > 0) {
          console.warn('Timeout for addRemoteCandidate. Consider sending ' +
              'an end-of-candidates notification');
          transceiver.iceTransport.addRemoteCandidate({});
        }
      });
    }, 4000);

    return Promise.resolve();
  };

  RTCPeerConnection.prototype.close = function() {
    this.transceivers.forEach(function(transceiver) {
      /* not yet
      if (transceiver.iceGatherer) {
        transceiver.iceGatherer.close();
      }
      */
      if (transceiver.iceTransport) {
        transceiver.iceTransport.stop();
      }
      if (transceiver.dtlsTransport) {
        transceiver.dtlsTransport.stop();
      }
      if (transceiver.rtpSender) {
        transceiver.rtpSender.stop();
      }
      if (transceiver.rtpReceiver) {
        transceiver.rtpReceiver.stop();
      }
    });
    // FIXME: clean up tracks, local streams, remote streams, etc
    this._isClosed = true;
    this._updateSignalingState('closed');
  };

  // Update the signaling state.
  RTCPeerConnection.prototype._updateSignalingState = function(newState) {
    this.signalingState = newState;
    var event = new Event('signalingstatechange');
    this._dispatchEvent('signalingstatechange', event);
  };

  // Determine whether to fire the negotiationneeded event.
  RTCPeerConnection.prototype._maybeFireNegotiationNeeded = function() {
    var pc = this;
    if (this.signalingState !== 'stable' || this.needNegotiation === true) {
      return;
    }
    this.needNegotiation = true;
    window.setTimeout(function() {
      if (pc.needNegotiation) {
        pc.needNegotiation = false;
        var event = new Event('negotiationneeded');
        pc._dispatchEvent('negotiationneeded', event);
      }
    }, 0);
  };

  // Update the ice connection state.
  RTCPeerConnection.prototype._updateIceConnectionState = function() {
    var newState;
    var states = {
      'new': 0,
      closed: 0,
      checking: 0,
      connected: 0,
      completed: 0,
      disconnected: 0,
      failed: 0
    };
    this.transceivers.forEach(function(transceiver) {
      if (transceiver.iceTransport && !transceiver.rejected) {
        states[transceiver.iceTransport.state]++;
      }
    });

    newState = 'new';
    if (states.failed > 0) {
      newState = 'failed';
    } else if (states.checking > 0) {
      newState = 'checking';
    } else if (states.disconnected > 0) {
      newState = 'disconnected';
    } else if (states.new > 0) {
      newState = 'new';
    } else if (states.connected > 0) {
      newState = 'connected';
    } else if (states.completed > 0) {
      newState = 'completed';
    }

    if (newState !== this.iceConnectionState) {
      this.iceConnectionState = newState;
      var event = new Event('iceconnectionstatechange');
      this._dispatchEvent('iceconnectionstatechange', event);
    }
  };

  // Update the connection state.
  RTCPeerConnection.prototype._updateConnectionState = function() {
    var newState;
    var states = {
      'new': 0,
      closed: 0,
      connecting: 0,
      connected: 0,
      completed: 0,
      disconnected: 0,
      failed: 0
    };
    this.transceivers.forEach(function(transceiver) {
      if (transceiver.iceTransport && transceiver.dtlsTransport &&
          !transceiver.rejected) {
        states[transceiver.iceTransport.state]++;
        states[transceiver.dtlsTransport.state]++;
      }
    });
    // ICETransport.completed and connected are the same for this purpose.
    states.connected += states.completed;

    newState = 'new';
    if (states.failed > 0) {
      newState = 'failed';
    } else if (states.connecting > 0) {
      newState = 'connecting';
    } else if (states.disconnected > 0) {
      newState = 'disconnected';
    } else if (states.new > 0) {
      newState = 'new';
    } else if (states.connected > 0) {
      newState = 'connected';
    }

    if (newState !== this.connectionState) {
      this.connectionState = newState;
      var event = new Event('connectionstatechange');
      this._dispatchEvent('connectionstatechange', event);
    }
  };

  RTCPeerConnection.prototype.createOffer = function() {
    var pc = this;

    if (pc._isClosed) {
      return Promise.reject(makeError('InvalidStateError',
          'Can not call createOffer after close'));
    }

    var numAudioTracks = pc.transceivers.filter(function(t) {
      return t.kind === 'audio';
    }).length;
    var numVideoTracks = pc.transceivers.filter(function(t) {
      return t.kind === 'video';
    }).length;

    // Determine number of audio and video tracks we need to send/recv.
    var offerOptions = arguments[0];
    if (offerOptions) {
      // Reject Chrome legacy constraints.
      if (offerOptions.mandatory || offerOptions.optional) {
        throw new TypeError(
            'Legacy mandatory/optional constraints not supported.');
      }
      if (offerOptions.offerToReceiveAudio !== undefined) {
        if (offerOptions.offerToReceiveAudio === true) {
          numAudioTracks = 1;
        } else if (offerOptions.offerToReceiveAudio === false) {
          numAudioTracks = 0;
        } else {
          numAudioTracks = offerOptions.offerToReceiveAudio;
        }
      }
      if (offerOptions.offerToReceiveVideo !== undefined) {
        if (offerOptions.offerToReceiveVideo === true) {
          numVideoTracks = 1;
        } else if (offerOptions.offerToReceiveVideo === false) {
          numVideoTracks = 0;
        } else {
          numVideoTracks = offerOptions.offerToReceiveVideo;
        }
      }
    }

    pc.transceivers.forEach(function(transceiver) {
      if (transceiver.kind === 'audio') {
        numAudioTracks--;
        if (numAudioTracks < 0) {
          transceiver.wantReceive = false;
        }
      } else if (transceiver.kind === 'video') {
        numVideoTracks--;
        if (numVideoTracks < 0) {
          transceiver.wantReceive = false;
        }
      }
    });

    // Create M-lines for recvonly streams.
    while (numAudioTracks > 0 || numVideoTracks > 0) {
      if (numAudioTracks > 0) {
        pc._createTransceiver('audio');
        numAudioTracks--;
      }
      if (numVideoTracks > 0) {
        pc._createTransceiver('video');
        numVideoTracks--;
      }
    }

    var sdp = SDPUtils.writeSessionBoilerplate(pc._sdpSessionId,
        pc._sdpSessionVersion++);
    pc.transceivers.forEach(function(transceiver, sdpMLineIndex) {
      // For each track, create an ice gatherer, ice transport,
      // dtls transport, potentially rtpsender and rtpreceiver.
      var track = transceiver.track;
      var kind = transceiver.kind;
      var mid = transceiver.mid || SDPUtils.generateIdentifier();
      transceiver.mid = mid;

      if (!transceiver.iceGatherer) {
        transceiver.iceGatherer = pc._createIceGatherer(sdpMLineIndex,
            pc.usingBundle);
      }

      var localCapabilities = window.RTCRtpSender.getCapabilities(kind);
      // filter RTX until additional stuff needed for RTX is implemented
      // in adapter.js
      if (edgeVersion < 15019) {
        localCapabilities.codecs = localCapabilities.codecs.filter(
            function(codec) {
              return codec.name !== 'rtx';
            });
      }
      localCapabilities.codecs.forEach(function(codec) {
        // work around https://bugs.chromium.org/p/webrtc/issues/detail?id=6552
        // by adding level-asymmetry-allowed=1
        if (codec.name === 'H264' &&
            codec.parameters['level-asymmetry-allowed'] === undefined) {
          codec.parameters['level-asymmetry-allowed'] = '1';
        }

        // for subsequent offers, we might have to re-use the payload
        // type of the last offer.
        if (transceiver.remoteCapabilities &&
            transceiver.remoteCapabilities.codecs) {
          transceiver.remoteCapabilities.codecs.forEach(function(remoteCodec) {
            if (codec.name.toLowerCase() === remoteCodec.name.toLowerCase() &&
                codec.clockRate === remoteCodec.clockRate) {
              codec.preferredPayloadType = remoteCodec.payloadType;
            }
          });
        }
      });
      localCapabilities.headerExtensions.forEach(function(hdrExt) {
        var remoteExtensions = transceiver.remoteCapabilities &&
            transceiver.remoteCapabilities.headerExtensions || [];
        remoteExtensions.forEach(function(rHdrExt) {
          if (hdrExt.uri === rHdrExt.uri) {
            hdrExt.id = rHdrExt.id;
          }
        });
      });

      // generate an ssrc now, to be used later in rtpSender.send
      var sendEncodingParameters = transceiver.sendEncodingParameters || [{
        ssrc: (2 * sdpMLineIndex + 1) * 1001
      }];
      if (track) {
        // add RTX
        if (edgeVersion >= 15019 && kind === 'video' &&
            !sendEncodingParameters[0].rtx) {
          sendEncodingParameters[0].rtx = {
            ssrc: sendEncodingParameters[0].ssrc + 1
          };
        }
      }

      if (transceiver.wantReceive) {
        transceiver.rtpReceiver = new window.RTCRtpReceiver(
            transceiver.dtlsTransport, kind);
      }

      transceiver.localCapabilities = localCapabilities;
      transceiver.sendEncodingParameters = sendEncodingParameters;
    });

    // always offer BUNDLE and dispose on return if not supported.
    if (pc._config.bundlePolicy !== 'max-compat') {
      sdp += 'a=group:BUNDLE ' + pc.transceivers.map(function(t) {
        return t.mid;
      }).join(' ') + '\r\n';
    }
    sdp += 'a=ice-options:trickle\r\n';

    pc.transceivers.forEach(function(transceiver, sdpMLineIndex) {
      sdp += writeMediaSection(transceiver, transceiver.localCapabilities,
          'offer', transceiver.stream, pc._dtlsRole);
      sdp += 'a=rtcp-rsize\r\n';

      if (transceiver.iceGatherer && pc.iceGatheringState !== 'new' &&
          (sdpMLineIndex === 0 || !pc.usingBundle)) {
        transceiver.iceGatherer.getLocalCandidates().forEach(function(cand) {
          cand.component = 1;
          sdp += 'a=' + SDPUtils.writeCandidate(cand) + '\r\n';
        });

        if (transceiver.iceGatherer.state === 'completed') {
          sdp += 'a=end-of-candidates\r\n';
        }
      }
    });

    var desc = new window.RTCSessionDescription({
      type: 'offer',
      sdp: sdp
    });
    return Promise.resolve(desc);
  };

  RTCPeerConnection.prototype.createAnswer = function() {
    var pc = this;

    if (pc._isClosed) {
      return Promise.reject(makeError('InvalidStateError',
          'Can not call createAnswer after close'));
    }

    if (!(pc.signalingState === 'have-remote-offer' ||
        pc.signalingState === 'have-local-pranswer')) {
      return Promise.reject(makeError('InvalidStateError',
          'Can not call createAnswer in signalingState ' + pc.signalingState));
    }

    var sdp = SDPUtils.writeSessionBoilerplate(pc._sdpSessionId,
        pc._sdpSessionVersion++);
    if (pc.usingBundle) {
      sdp += 'a=group:BUNDLE ' + pc.transceivers.map(function(t) {
        return t.mid;
      }).join(' ') + '\r\n';
    }
    sdp += 'a=ice-options:trickle\r\n';

    var mediaSectionsInOffer = SDPUtils.getMediaSections(
        pc._remoteDescription.sdp).length;
    pc.transceivers.forEach(function(transceiver, sdpMLineIndex) {
      if (sdpMLineIndex + 1 > mediaSectionsInOffer) {
        return;
      }
      if (transceiver.rejected) {
        if (transceiver.kind === 'application') {
          if (transceiver.protocol === 'DTLS/SCTP') { // legacy fmt
            sdp += 'm=application 0 DTLS/SCTP 5000\r\n';
          } else {
            sdp += 'm=application 0 ' + transceiver.protocol +
                ' webrtc-datachannel\r\n';
          }
        } else if (transceiver.kind === 'audio') {
          sdp += 'm=audio 0 UDP/TLS/RTP/SAVPF 0\r\n' +
              'a=rtpmap:0 PCMU/8000\r\n';
        } else if (transceiver.kind === 'video') {
          sdp += 'm=video 0 UDP/TLS/RTP/SAVPF 120\r\n' +
              'a=rtpmap:120 VP8/90000\r\n';
        }
        sdp += 'c=IN IP4 0.0.0.0\r\n' +
            'a=inactive\r\n' +
            'a=mid:' + transceiver.mid + '\r\n';
        return;
      }

      // FIXME: look at direction.
      if (transceiver.stream) {
        var localTrack;
        if (transceiver.kind === 'audio') {
          localTrack = transceiver.stream.getAudioTracks()[0];
        } else if (transceiver.kind === 'video') {
          localTrack = transceiver.stream.getVideoTracks()[0];
        }
        if (localTrack) {
          // add RTX
          if (edgeVersion >= 15019 && transceiver.kind === 'video' &&
              !transceiver.sendEncodingParameters[0].rtx) {
            transceiver.sendEncodingParameters[0].rtx = {
              ssrc: transceiver.sendEncodingParameters[0].ssrc + 1
            };
          }
        }
      }

      // Calculate intersection of capabilities.
      var commonCapabilities = getCommonCapabilities(
          transceiver.localCapabilities,
          transceiver.remoteCapabilities);

      var hasRtx = commonCapabilities.codecs.filter(function(c) {
        return c.name.toLowerCase() === 'rtx';
      }).length;
      if (!hasRtx && transceiver.sendEncodingParameters[0].rtx) {
        delete transceiver.sendEncodingParameters[0].rtx;
      }

      sdp += writeMediaSection(transceiver, commonCapabilities,
          'answer', transceiver.stream, pc._dtlsRole);
      if (transceiver.rtcpParameters &&
          transceiver.rtcpParameters.reducedSize) {
        sdp += 'a=rtcp-rsize\r\n';
      }
    });

    var desc = new window.RTCSessionDescription({
      type: 'answer',
      sdp: sdp
    });
    return Promise.resolve(desc);
  };

  RTCPeerConnection.prototype.addIceCandidate = function(candidate) {
    var pc = this;
    var sections;
    if (candidate && !(candidate.sdpMLineIndex !== undefined ||
        candidate.sdpMid)) {
      return Promise.reject(new TypeError('sdpMLineIndex or sdpMid required'));
    }

    // TODO: needs to go into ops queue.
    return new Promise(function(resolve, reject) {
      if (!pc._remoteDescription) {
        return reject(makeError('InvalidStateError',
            'Can not add ICE candidate without a remote description'));
      } else if (!candidate || candidate.candidate === '') {
        for (var j = 0; j < pc.transceivers.length; j++) {
          if (pc.transceivers[j].rejected) {
            continue;
          }
          pc.transceivers[j].iceTransport.addRemoteCandidate({});
          sections = SDPUtils.getMediaSections(pc._remoteDescription.sdp);
          sections[j] += 'a=end-of-candidates\r\n';
          pc._remoteDescription.sdp =
              SDPUtils.getDescription(pc._remoteDescription.sdp) +
              sections.join('');
          if (pc.usingBundle) {
            break;
          }
        }
      } else {
        var sdpMLineIndex = candidate.sdpMLineIndex;
        if (candidate.sdpMid) {
          for (var i = 0; i < pc.transceivers.length; i++) {
            if (pc.transceivers[i].mid === candidate.sdpMid) {
              sdpMLineIndex = i;
              break;
            }
          }
        }
        var transceiver = pc.transceivers[sdpMLineIndex];
        if (transceiver) {
          if (transceiver.rejected) {
            return resolve();
          }
          var cand = Object.keys(candidate.candidate).length > 0 ?
              SDPUtils.parseCandidate(candidate.candidate) : {};
          // Ignore Chrome's invalid candidates since Edge does not like them.
          if (cand.protocol === 'tcp' && (cand.port === 0 || cand.port === 9)) {
            return resolve();
          }
          // Ignore RTCP candidates, we assume RTCP-MUX.
          if (cand.component && cand.component !== 1) {
            return resolve();
          }
          // when using bundle, avoid adding candidates to the wrong
          // ice transport. And avoid adding candidates added in the SDP.
          if (sdpMLineIndex === 0 || (sdpMLineIndex > 0 &&
              transceiver.iceTransport !== pc.transceivers[0].iceTransport)) {
            if (!maybeAddCandidate(transceiver.iceTransport, cand)) {
              return reject(makeError('OperationError',
                  'Can not add ICE candidate'));
            }
          }

          // update the remoteDescription.
          var candidateString = candidate.candidate.trim();
          if (candidateString.indexOf('a=') === 0) {
            candidateString = candidateString.substr(2);
          }
          sections = SDPUtils.getMediaSections(pc._remoteDescription.sdp);
          sections[sdpMLineIndex] += 'a=' +
              (cand.type ? candidateString : 'end-of-candidates')
              + '\r\n';
          pc._remoteDescription.sdp =
              SDPUtils.getDescription(pc._remoteDescription.sdp) +
              sections.join('');
        } else {
          return reject(makeError('OperationError',
              'Can not add ICE candidate'));
        }
      }
      resolve();
    });
  };

  RTCPeerConnection.prototype.getStats = function(selector) {
    if (selector && selector instanceof window.MediaStreamTrack) {
      var senderOrReceiver = null;
      this.transceivers.forEach(function(transceiver) {
        if (transceiver.rtpSender &&
            transceiver.rtpSender.track === selector) {
          senderOrReceiver = transceiver.rtpSender;
        } else if (transceiver.rtpReceiver &&
            transceiver.rtpReceiver.track === selector) {
          senderOrReceiver = transceiver.rtpReceiver;
        }
      });
      if (!senderOrReceiver) {
        throw makeError('InvalidAccessError', 'Invalid selector.');
      }
      return senderOrReceiver.getStats();
    }

    var promises = [];
    this.transceivers.forEach(function(transceiver) {
      ['rtpSender', 'rtpReceiver', 'iceGatherer', 'iceTransport',
          'dtlsTransport'].forEach(function(method) {
            if (transceiver[method]) {
              promises.push(transceiver[method].getStats());
            }
          });
    });
    return Promise.all(promises).then(function(allStats) {
      var results = new Map();
      allStats.forEach(function(stats) {
        stats.forEach(function(stat) {
          results.set(stat.id, stat);
        });
      });
      return results;
    });
  };

  // fix low-level stat names and return Map instead of object.
  var ortcObjects = ['RTCRtpSender', 'RTCRtpReceiver', 'RTCIceGatherer',
    'RTCIceTransport', 'RTCDtlsTransport'];
  ortcObjects.forEach(function(ortcObjectName) {
    var obj = window[ortcObjectName];
    if (obj && obj.prototype && obj.prototype.getStats) {
      var nativeGetstats = obj.prototype.getStats;
      obj.prototype.getStats = function() {
        return nativeGetstats.apply(this)
        .then(function(nativeStats) {
          var mapStats = new Map();
          Object.keys(nativeStats).forEach(function(id) {
            nativeStats[id].type = fixStatsType(nativeStats[id]);
            mapStats.set(id, nativeStats[id]);
          });
          return mapStats;
        });
      };
    }
  });

  // legacy callback shims. Should be moved to adapter.js some days.
  var methods = ['createOffer', 'createAnswer'];
  methods.forEach(function(method) {
    var nativeMethod = RTCPeerConnection.prototype[method];
    RTCPeerConnection.prototype[method] = function() {
      var args = arguments;
      if (typeof args[0] === 'function' ||
          typeof args[1] === 'function') { // legacy
        return nativeMethod.apply(this, [arguments[2]])
        .then(function(description) {
          if (typeof args[0] === 'function') {
            args[0].apply(null, [description]);
          }
        }, function(error) {
          if (typeof args[1] === 'function') {
            args[1].apply(null, [error]);
          }
        });
      }
      return nativeMethod.apply(this, arguments);
    };
  });

  methods = ['setLocalDescription', 'setRemoteDescription', 'addIceCandidate'];
  methods.forEach(function(method) {
    var nativeMethod = RTCPeerConnection.prototype[method];
    RTCPeerConnection.prototype[method] = function() {
      var args = arguments;
      if (typeof args[1] === 'function' ||
          typeof args[2] === 'function') { // legacy
        return nativeMethod.apply(this, arguments)
        .then(function() {
          if (typeof args[1] === 'function') {
            args[1].apply(null);
          }
        }, function(error) {
          if (typeof args[2] === 'function') {
            args[2].apply(null, [error]);
          }
        });
      }
      return nativeMethod.apply(this, arguments);
    };
  });

  // getStats is special. It doesn't have a spec legacy method yet we support
  // getStats(something, cb) without error callbacks.
  ['getStats'].forEach(function(method) {
    var nativeMethod = RTCPeerConnection.prototype[method];
    RTCPeerConnection.prototype[method] = function() {
      var args = arguments;
      if (typeof args[1] === 'function') {
        return nativeMethod.apply(this, arguments)
        .then(function() {
          if (typeof args[1] === 'function') {
            args[1].apply(null);
          }
        });
      }
      return nativeMethod.apply(this, arguments);
    };
  });

  return RTCPeerConnection;
};

},{"sdp":58}],58:[function(require,module,exports){
/* eslint-env node */
'use strict';

// SDP helpers.
var SDPUtils = {};

// Generate an alphanumeric identifier for cname or mids.
// TODO: use UUIDs instead? https://gist.github.com/jed/982883
SDPUtils.generateIdentifier = function() {
  return Math.random().toString(36).substr(2, 10);
};

// The RTCP CNAME used by all peerconnections from the same JS.
SDPUtils.localCName = SDPUtils.generateIdentifier();

// Splits SDP into lines, dealing with both CRLF and LF.
SDPUtils.splitLines = function(blob) {
  return blob.trim().split('\n').map(function(line) {
    return line.trim();
  });
};
// Splits SDP into sessionpart and mediasections. Ensures CRLF.
SDPUtils.splitSections = function(blob) {
  var parts = blob.split('\nm=');
  return parts.map(function(part, index) {
    return (index > 0 ? 'm=' + part : part).trim() + '\r\n';
  });
};

// returns the session description.
SDPUtils.getDescription = function(blob) {
  var sections = SDPUtils.splitSections(blob);
  return sections && sections[0];
};

// returns the individual media sections.
SDPUtils.getMediaSections = function(blob) {
  var sections = SDPUtils.splitSections(blob);
  sections.shift();
  return sections;
};

// Returns lines that start with a certain prefix.
SDPUtils.matchPrefix = function(blob, prefix) {
  return SDPUtils.splitLines(blob).filter(function(line) {
    return line.indexOf(prefix) === 0;
  });
};

// Parses an ICE candidate line. Sample input:
// candidate:702786350 2 udp 41819902 8.8.8.8 60769 typ relay raddr 8.8.8.8
// rport 55996"
SDPUtils.parseCandidate = function(line) {
  var parts;
  // Parse both variants.
  if (line.indexOf('a=candidate:') === 0) {
    parts = line.substring(12).split(' ');
  } else {
    parts = line.substring(10).split(' ');
  }

  var candidate = {
    foundation: parts[0],
    component: parseInt(parts[1], 10),
    protocol: parts[2].toLowerCase(),
    priority: parseInt(parts[3], 10),
    ip: parts[4],
    address: parts[4], // address is an alias for ip.
    port: parseInt(parts[5], 10),
    // skip parts[6] == 'typ'
    type: parts[7]
  };

  for (var i = 8; i < parts.length; i += 2) {
    switch (parts[i]) {
      case 'raddr':
        candidate.relatedAddress = parts[i + 1];
        break;
      case 'rport':
        candidate.relatedPort = parseInt(parts[i + 1], 10);
        break;
      case 'tcptype':
        candidate.tcpType = parts[i + 1];
        break;
      case 'ufrag':
        candidate.ufrag = parts[i + 1]; // for backward compability.
        candidate.usernameFragment = parts[i + 1];
        break;
      default: // extension handling, in particular ufrag
        candidate[parts[i]] = parts[i + 1];
        break;
    }
  }
  return candidate;
};

// Translates a candidate object into SDP candidate attribute.
SDPUtils.writeCandidate = function(candidate) {
  var sdp = [];
  sdp.push(candidate.foundation);
  sdp.push(candidate.component);
  sdp.push(candidate.protocol.toUpperCase());
  sdp.push(candidate.priority);
  sdp.push(candidate.address || candidate.ip);
  sdp.push(candidate.port);

  var type = candidate.type;
  sdp.push('typ');
  sdp.push(type);
  if (type !== 'host' && candidate.relatedAddress &&
      candidate.relatedPort) {
    sdp.push('raddr');
    sdp.push(candidate.relatedAddress);
    sdp.push('rport');
    sdp.push(candidate.relatedPort);
  }
  if (candidate.tcpType && candidate.protocol.toLowerCase() === 'tcp') {
    sdp.push('tcptype');
    sdp.push(candidate.tcpType);
  }
  if (candidate.usernameFragment || candidate.ufrag) {
    sdp.push('ufrag');
    sdp.push(candidate.usernameFragment || candidate.ufrag);
  }
  return 'candidate:' + sdp.join(' ');
};

// Parses an ice-options line, returns an array of option tags.
// a=ice-options:foo bar
SDPUtils.parseIceOptions = function(line) {
  return line.substr(14).split(' ');
};

// Parses an rtpmap line, returns RTCRtpCoddecParameters. Sample input:
// a=rtpmap:111 opus/48000/2
SDPUtils.parseRtpMap = function(line) {
  var parts = line.substr(9).split(' ');
  var parsed = {
    payloadType: parseInt(parts.shift(), 10) // was: id
  };

  parts = parts[0].split('/');

  parsed.name = parts[0];
  parsed.clockRate = parseInt(parts[1], 10); // was: clockrate
  parsed.channels = parts.length === 3 ? parseInt(parts[2], 10) : 1;
  // legacy alias, got renamed back to channels in ORTC.
  parsed.numChannels = parsed.channels;
  return parsed;
};

// Generate an a=rtpmap line from RTCRtpCodecCapability or
// RTCRtpCodecParameters.
SDPUtils.writeRtpMap = function(codec) {
  var pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  var channels = codec.channels || codec.numChannels || 1;
  return 'a=rtpmap:' + pt + ' ' + codec.name + '/' + codec.clockRate +
      (channels !== 1 ? '/' + channels : '') + '\r\n';
};

// Parses an a=extmap line (headerextension from RFC 5285). Sample input:
// a=extmap:2 urn:ietf:params:rtp-hdrext:toffset
// a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:toffset
SDPUtils.parseExtmap = function(line) {
  var parts = line.substr(9).split(' ');
  return {
    id: parseInt(parts[0], 10),
    direction: parts[0].indexOf('/') > 0 ? parts[0].split('/')[1] : 'sendrecv',
    uri: parts[1]
  };
};

// Generates a=extmap line from RTCRtpHeaderExtensionParameters or
// RTCRtpHeaderExtension.
SDPUtils.writeExtmap = function(headerExtension) {
  return 'a=extmap:' + (headerExtension.id || headerExtension.preferredId) +
      (headerExtension.direction && headerExtension.direction !== 'sendrecv'
        ? '/' + headerExtension.direction
        : '') +
      ' ' + headerExtension.uri + '\r\n';
};

// Parses an ftmp line, returns dictionary. Sample input:
// a=fmtp:96 vbr=on;cng=on
// Also deals with vbr=on; cng=on
SDPUtils.parseFmtp = function(line) {
  var parsed = {};
  var kv;
  var parts = line.substr(line.indexOf(' ') + 1).split(';');
  for (var j = 0; j < parts.length; j++) {
    kv = parts[j].trim().split('=');
    parsed[kv[0].trim()] = kv[1];
  }
  return parsed;
};

// Generates an a=ftmp line from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeFmtp = function(codec) {
  var line = '';
  var pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.parameters && Object.keys(codec.parameters).length) {
    var params = [];
    Object.keys(codec.parameters).forEach(function(param) {
      if (codec.parameters[param]) {
        params.push(param + '=' + codec.parameters[param]);
      } else {
        params.push(param);
      }
    });
    line += 'a=fmtp:' + pt + ' ' + params.join(';') + '\r\n';
  }
  return line;
};

// Parses an rtcp-fb line, returns RTCPRtcpFeedback object. Sample input:
// a=rtcp-fb:98 nack rpsi
SDPUtils.parseRtcpFb = function(line) {
  var parts = line.substr(line.indexOf(' ') + 1).split(' ');
  return {
    type: parts.shift(),
    parameter: parts.join(' ')
  };
};
// Generate a=rtcp-fb lines from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeRtcpFb = function(codec) {
  var lines = '';
  var pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.rtcpFeedback && codec.rtcpFeedback.length) {
    // FIXME: special handling for trr-int?
    codec.rtcpFeedback.forEach(function(fb) {
      lines += 'a=rtcp-fb:' + pt + ' ' + fb.type +
      (fb.parameter && fb.parameter.length ? ' ' + fb.parameter : '') +
          '\r\n';
    });
  }
  return lines;
};

// Parses an RFC 5576 ssrc media attribute. Sample input:
// a=ssrc:3735928559 cname:something
SDPUtils.parseSsrcMedia = function(line) {
  var sp = line.indexOf(' ');
  var parts = {
    ssrc: parseInt(line.substr(7, sp - 7), 10)
  };
  var colon = line.indexOf(':', sp);
  if (colon > -1) {
    parts.attribute = line.substr(sp + 1, colon - sp - 1);
    parts.value = line.substr(colon + 1);
  } else {
    parts.attribute = line.substr(sp + 1);
  }
  return parts;
};

SDPUtils.parseSsrcGroup = function(line) {
  var parts = line.substr(13).split(' ');
  return {
    semantics: parts.shift(),
    ssrcs: parts.map(function(ssrc) {
      return parseInt(ssrc, 10);
    })
  };
};

// Extracts the MID (RFC 5888) from a media section.
// returns the MID or undefined if no mid line was found.
SDPUtils.getMid = function(mediaSection) {
  var mid = SDPUtils.matchPrefix(mediaSection, 'a=mid:')[0];
  if (mid) {
    return mid.substr(6);
  }
};

SDPUtils.parseFingerprint = function(line) {
  var parts = line.substr(14).split(' ');
  return {
    algorithm: parts[0].toLowerCase(), // algorithm is case-sensitive in Edge.
    value: parts[1]
  };
};

// Extracts DTLS parameters from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the fingerprint line as input. See also getIceParameters.
SDPUtils.getDtlsParameters = function(mediaSection, sessionpart) {
  var lines = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=fingerprint:');
  // Note: a=setup line is ignored since we use the 'auto' role.
  // Note2: 'algorithm' is not case sensitive except in Edge.
  return {
    role: 'auto',
    fingerprints: lines.map(SDPUtils.parseFingerprint)
  };
};

// Serializes DTLS parameters to SDP.
SDPUtils.writeDtlsParameters = function(params, setupType) {
  var sdp = 'a=setup:' + setupType + '\r\n';
  params.fingerprints.forEach(function(fp) {
    sdp += 'a=fingerprint:' + fp.algorithm + ' ' + fp.value + '\r\n';
  });
  return sdp;
};
// Parses ICE information from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the ice-ufrag and ice-pwd lines as input.
SDPUtils.getIceParameters = function(mediaSection, sessionpart) {
  var lines = SDPUtils.splitLines(mediaSection);
  // Search in session part, too.
  lines = lines.concat(SDPUtils.splitLines(sessionpart));
  var iceParameters = {
    usernameFragment: lines.filter(function(line) {
      return line.indexOf('a=ice-ufrag:') === 0;
    })[0].substr(12),
    password: lines.filter(function(line) {
      return line.indexOf('a=ice-pwd:') === 0;
    })[0].substr(10)
  };
  return iceParameters;
};

// Serializes ICE parameters to SDP.
SDPUtils.writeIceParameters = function(params) {
  return 'a=ice-ufrag:' + params.usernameFragment + '\r\n' +
      'a=ice-pwd:' + params.password + '\r\n';
};

// Parses the SDP media section and returns RTCRtpParameters.
SDPUtils.parseRtpParameters = function(mediaSection) {
  var description = {
    codecs: [],
    headerExtensions: [],
    fecMechanisms: [],
    rtcp: []
  };
  var lines = SDPUtils.splitLines(mediaSection);
  var mline = lines[0].split(' ');
  for (var i = 3; i < mline.length; i++) { // find all codecs from mline[3..]
    var pt = mline[i];
    var rtpmapline = SDPUtils.matchPrefix(
      mediaSection, 'a=rtpmap:' + pt + ' ')[0];
    if (rtpmapline) {
      var codec = SDPUtils.parseRtpMap(rtpmapline);
      var fmtps = SDPUtils.matchPrefix(
        mediaSection, 'a=fmtp:' + pt + ' ');
      // Only the first a=fmtp:<pt> is considered.
      codec.parameters = fmtps.length ? SDPUtils.parseFmtp(fmtps[0]) : {};
      codec.rtcpFeedback = SDPUtils.matchPrefix(
        mediaSection, 'a=rtcp-fb:' + pt + ' ')
        .map(SDPUtils.parseRtcpFb);
      description.codecs.push(codec);
      // parse FEC mechanisms from rtpmap lines.
      switch (codec.name.toUpperCase()) {
        case 'RED':
        case 'ULPFEC':
          description.fecMechanisms.push(codec.name.toUpperCase());
          break;
        default: // only RED and ULPFEC are recognized as FEC mechanisms.
          break;
      }
    }
  }
  SDPUtils.matchPrefix(mediaSection, 'a=extmap:').forEach(function(line) {
    description.headerExtensions.push(SDPUtils.parseExtmap(line));
  });
  // FIXME: parse rtcp.
  return description;
};

// Generates parts of the SDP media section describing the capabilities /
// parameters.
SDPUtils.writeRtpDescription = function(kind, caps) {
  var sdp = '';

  // Build the mline.
  sdp += 'm=' + kind + ' ';
  sdp += caps.codecs.length > 0 ? '9' : '0'; // reject if no codecs.
  sdp += ' UDP/TLS/RTP/SAVPF ';
  sdp += caps.codecs.map(function(codec) {
    if (codec.preferredPayloadType !== undefined) {
      return codec.preferredPayloadType;
    }
    return codec.payloadType;
  }).join(' ') + '\r\n';

  sdp += 'c=IN IP4 0.0.0.0\r\n';
  sdp += 'a=rtcp:9 IN IP4 0.0.0.0\r\n';

  // Add a=rtpmap lines for each codec. Also fmtp and rtcp-fb.
  caps.codecs.forEach(function(codec) {
    sdp += SDPUtils.writeRtpMap(codec);
    sdp += SDPUtils.writeFmtp(codec);
    sdp += SDPUtils.writeRtcpFb(codec);
  });
  var maxptime = 0;
  caps.codecs.forEach(function(codec) {
    if (codec.maxptime > maxptime) {
      maxptime = codec.maxptime;
    }
  });
  if (maxptime > 0) {
    sdp += 'a=maxptime:' + maxptime + '\r\n';
  }
  sdp += 'a=rtcp-mux\r\n';

  if (caps.headerExtensions) {
    caps.headerExtensions.forEach(function(extension) {
      sdp += SDPUtils.writeExtmap(extension);
    });
  }
  // FIXME: write fecMechanisms.
  return sdp;
};

// Parses the SDP media section and returns an array of
// RTCRtpEncodingParameters.
SDPUtils.parseRtpEncodingParameters = function(mediaSection) {
  var encodingParameters = [];
  var description = SDPUtils.parseRtpParameters(mediaSection);
  var hasRed = description.fecMechanisms.indexOf('RED') !== -1;
  var hasUlpfec = description.fecMechanisms.indexOf('ULPFEC') !== -1;

  // filter a=ssrc:... cname:, ignore PlanB-msid
  var ssrcs = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(function(line) {
      return SDPUtils.parseSsrcMedia(line);
    })
    .filter(function(parts) {
      return parts.attribute === 'cname';
    });
  var primarySsrc = ssrcs.length > 0 && ssrcs[0].ssrc;
  var secondarySsrc;

  var flows = SDPUtils.matchPrefix(mediaSection, 'a=ssrc-group:FID')
    .map(function(line) {
      var parts = line.substr(17).split(' ');
      return parts.map(function(part) {
        return parseInt(part, 10);
      });
    });
  if (flows.length > 0 && flows[0].length > 1 && flows[0][0] === primarySsrc) {
    secondarySsrc = flows[0][1];
  }

  description.codecs.forEach(function(codec) {
    if (codec.name.toUpperCase() === 'RTX' && codec.parameters.apt) {
      var encParam = {
        ssrc: primarySsrc,
        codecPayloadType: parseInt(codec.parameters.apt, 10)
      };
      if (primarySsrc && secondarySsrc) {
        encParam.rtx = {ssrc: secondarySsrc};
      }
      encodingParameters.push(encParam);
      if (hasRed) {
        encParam = JSON.parse(JSON.stringify(encParam));
        encParam.fec = {
          ssrc: primarySsrc,
          mechanism: hasUlpfec ? 'red+ulpfec' : 'red'
        };
        encodingParameters.push(encParam);
      }
    }
  });
  if (encodingParameters.length === 0 && primarySsrc) {
    encodingParameters.push({
      ssrc: primarySsrc
    });
  }

  // we support both b=AS and b=TIAS but interpret AS as TIAS.
  var bandwidth = SDPUtils.matchPrefix(mediaSection, 'b=');
  if (bandwidth.length) {
    if (bandwidth[0].indexOf('b=TIAS:') === 0) {
      bandwidth = parseInt(bandwidth[0].substr(7), 10);
    } else if (bandwidth[0].indexOf('b=AS:') === 0) {
      // use formula from JSEP to convert b=AS to TIAS value.
      bandwidth = parseInt(bandwidth[0].substr(5), 10) * 1000 * 0.95
          - (50 * 40 * 8);
    } else {
      bandwidth = undefined;
    }
    encodingParameters.forEach(function(params) {
      params.maxBitrate = bandwidth;
    });
  }
  return encodingParameters;
};

// parses http://draft.ortc.org/#rtcrtcpparameters*
SDPUtils.parseRtcpParameters = function(mediaSection) {
  var rtcpParameters = {};

  // Gets the first SSRC. Note tha with RTX there might be multiple
  // SSRCs.
  var remoteSsrc = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(function(line) {
      return SDPUtils.parseSsrcMedia(line);
    })
    .filter(function(obj) {
      return obj.attribute === 'cname';
    })[0];
  if (remoteSsrc) {
    rtcpParameters.cname = remoteSsrc.value;
    rtcpParameters.ssrc = remoteSsrc.ssrc;
  }

  // Edge uses the compound attribute instead of reducedSize
  // compound is !reducedSize
  var rsize = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-rsize');
  rtcpParameters.reducedSize = rsize.length > 0;
  rtcpParameters.compound = rsize.length === 0;

  // parses the rtcp-mux attrіbute.
  // Note that Edge does not support unmuxed RTCP.
  var mux = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-mux');
  rtcpParameters.mux = mux.length > 0;

  return rtcpParameters;
};

// parses either a=msid: or a=ssrc:... msid lines and returns
// the id of the MediaStream and MediaStreamTrack.
SDPUtils.parseMsid = function(mediaSection) {
  var parts;
  var spec = SDPUtils.matchPrefix(mediaSection, 'a=msid:');
  if (spec.length === 1) {
    parts = spec[0].substr(7).split(' ');
    return {stream: parts[0], track: parts[1]};
  }
  var planB = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(function(line) {
      return SDPUtils.parseSsrcMedia(line);
    })
    .filter(function(msidParts) {
      return msidParts.attribute === 'msid';
    });
  if (planB.length > 0) {
    parts = planB[0].value.split(' ');
    return {stream: parts[0], track: parts[1]};
  }
};

// SCTP
// parses draft-ietf-mmusic-sctp-sdp-26 first and falls back
// to draft-ietf-mmusic-sctp-sdp-05
SDPUtils.parseSctpDescription = function(mediaSection) {
  var mline = SDPUtils.parseMLine(mediaSection);
  var maxSizeLine = SDPUtils.matchPrefix(mediaSection, 'a=max-message-size:');
  var maxMessageSize;
  if (maxSizeLine.length > 0) {
    maxMessageSize = parseInt(maxSizeLine[0].substr(19), 10);
  }
  if (isNaN(maxMessageSize)) {
    maxMessageSize = 65536;
  }
  var sctpPort = SDPUtils.matchPrefix(mediaSection, 'a=sctp-port:');
  if (sctpPort.length > 0) {
    return {
      port: parseInt(sctpPort[0].substr(12), 10),
      protocol: mline.fmt,
      maxMessageSize: maxMessageSize
    };
  }
  var sctpMapLines = SDPUtils.matchPrefix(mediaSection, 'a=sctpmap:');
  if (sctpMapLines.length > 0) {
    var parts = SDPUtils.matchPrefix(mediaSection, 'a=sctpmap:')[0]
      .substr(10)
      .split(' ');
    return {
      port: parseInt(parts[0], 10),
      protocol: parts[1],
      maxMessageSize: maxMessageSize
    };
  }
};

// SCTP
// outputs the draft-ietf-mmusic-sctp-sdp-26 version that all browsers
// support by now receiving in this format, unless we originally parsed
// as the draft-ietf-mmusic-sctp-sdp-05 format (indicated by the m-line
// protocol of DTLS/SCTP -- without UDP/ or TCP/)
SDPUtils.writeSctpDescription = function(media, sctp) {
  var output = [];
  if (media.protocol !== 'DTLS/SCTP') {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.protocol + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctp-port:' + sctp.port + '\r\n'
    ];
  } else {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.port + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctpmap:' + sctp.port + ' ' + sctp.protocol + ' 65535\r\n'
    ];
  }
  if (sctp.maxMessageSize !== undefined) {
    output.push('a=max-message-size:' + sctp.maxMessageSize + '\r\n');
  }
  return output.join('');
};

// Generate a session ID for SDP.
// https://tools.ietf.org/html/draft-ietf-rtcweb-jsep-20#section-5.2.1
// recommends using a cryptographically random +ve 64-bit value
// but right now this should be acceptable and within the right range
SDPUtils.generateSessionId = function() {
  return Math.random().toString().substr(2, 21);
};

// Write boilder plate for start of SDP
// sessId argument is optional - if not supplied it will
// be generated randomly
// sessVersion is optional and defaults to 2
// sessUser is optional and defaults to 'thisisadapterortc'
SDPUtils.writeSessionBoilerplate = function(sessId, sessVer, sessUser) {
  var sessionId;
  var version = sessVer !== undefined ? sessVer : 2;
  if (sessId) {
    sessionId = sessId;
  } else {
    sessionId = SDPUtils.generateSessionId();
  }
  var user = sessUser || 'thisisadapterortc';
  // FIXME: sess-id should be an NTP timestamp.
  return 'v=0\r\n' +
      'o=' + user + ' ' + sessionId + ' ' + version +
        ' IN IP4 127.0.0.1\r\n' +
      's=-\r\n' +
      't=0 0\r\n';
};

SDPUtils.writeMediaSection = function(transceiver, caps, type, stream) {
  var sdp = SDPUtils.writeRtpDescription(transceiver.kind, caps);

  // Map ICE parameters (ufrag, pwd) to SDP.
  sdp += SDPUtils.writeIceParameters(
    transceiver.iceGatherer.getLocalParameters());

  // Map DTLS parameters to SDP.
  sdp += SDPUtils.writeDtlsParameters(
    transceiver.dtlsTransport.getLocalParameters(),
    type === 'offer' ? 'actpass' : 'active');

  sdp += 'a=mid:' + transceiver.mid + '\r\n';

  if (transceiver.direction) {
    sdp += 'a=' + transceiver.direction + '\r\n';
  } else if (transceiver.rtpSender && transceiver.rtpReceiver) {
    sdp += 'a=sendrecv\r\n';
  } else if (transceiver.rtpSender) {
    sdp += 'a=sendonly\r\n';
  } else if (transceiver.rtpReceiver) {
    sdp += 'a=recvonly\r\n';
  } else {
    sdp += 'a=inactive\r\n';
  }

  if (transceiver.rtpSender) {
    // spec.
    var msid = 'msid:' + stream.id + ' ' +
        transceiver.rtpSender.track.id + '\r\n';
    sdp += 'a=' + msid;

    // for Chrome.
    sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].ssrc +
        ' ' + msid;
    if (transceiver.sendEncodingParameters[0].rtx) {
      sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].rtx.ssrc +
          ' ' + msid;
      sdp += 'a=ssrc-group:FID ' +
          transceiver.sendEncodingParameters[0].ssrc + ' ' +
          transceiver.sendEncodingParameters[0].rtx.ssrc +
          '\r\n';
    }
  }
  // FIXME: this should be written by writeRtpDescription.
  sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].ssrc +
      ' cname:' + SDPUtils.localCName + '\r\n';
  if (transceiver.rtpSender && transceiver.sendEncodingParameters[0].rtx) {
    sdp += 'a=ssrc:' + transceiver.sendEncodingParameters[0].rtx.ssrc +
        ' cname:' + SDPUtils.localCName + '\r\n';
  }
  return sdp;
};

// Gets the direction from the mediaSection or the sessionpart.
SDPUtils.getDirection = function(mediaSection, sessionpart) {
  // Look for sendrecv, sendonly, recvonly, inactive, default to sendrecv.
  var lines = SDPUtils.splitLines(mediaSection);
  for (var i = 0; i < lines.length; i++) {
    switch (lines[i]) {
      case 'a=sendrecv':
      case 'a=sendonly':
      case 'a=recvonly':
      case 'a=inactive':
        return lines[i].substr(2);
      default:
        // FIXME: What should happen here?
    }
  }
  if (sessionpart) {
    return SDPUtils.getDirection(sessionpart);
  }
  return 'sendrecv';
};

SDPUtils.getKind = function(mediaSection) {
  var lines = SDPUtils.splitLines(mediaSection);
  var mline = lines[0].split(' ');
  return mline[0].substr(2);
};

SDPUtils.isRejected = function(mediaSection) {
  return mediaSection.split(' ', 2)[1] === '0';
};

SDPUtils.parseMLine = function(mediaSection) {
  var lines = SDPUtils.splitLines(mediaSection);
  var parts = lines[0].substr(2).split(' ');
  return {
    kind: parts[0],
    port: parseInt(parts[1], 10),
    protocol: parts[2],
    fmt: parts.slice(3).join(' ')
  };
};

SDPUtils.parseOLine = function(mediaSection) {
  var line = SDPUtils.matchPrefix(mediaSection, 'o=')[0];
  var parts = line.substr(2).split(' ');
  return {
    username: parts[0],
    sessionId: parts[1],
    sessionVersion: parseInt(parts[2], 10),
    netType: parts[3],
    addressType: parts[4],
    address: parts[5]
  };
};

// a very naive interpretation of a valid SDP.
SDPUtils.isValidSDP = function(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    return false;
  }
  var lines = SDPUtils.splitLines(blob);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length < 2 || lines[i].charAt(1) !== '=') {
      return false;
    }
    // TODO: check the modifier a bit more.
  }
  return true;
};

// Expose public methods.
if (typeof module === 'object') {
  module.exports = SDPUtils;
}

},{}],59:[function(require,module,exports){

/**
 * Module dependencies.
 */

var url = require('./url');
var parser = require('socket.io-parser');
var Manager = require('./manager');
var debug = require('debug')('socket.io-client');

/**
 * Module exports.
 */

module.exports = exports = lookup;

/**
 * Managers cache.
 */

var cache = exports.managers = {};

/**
 * Looks up an existing `Manager` for multiplexing.
 * If the user summons:
 *
 *   `io('http://localhost/a');`
 *   `io('http://localhost/b');`
 *
 * We reuse the existing instance based on same scheme/port/host,
 * and we initialize sockets for each namespace.
 *
 * @api public
 */

function lookup (uri, opts) {
  if (typeof uri === 'object') {
    opts = uri;
    uri = undefined;
  }

  opts = opts || {};

  var parsed = url(uri);
  var source = parsed.source;
  var id = parsed.id;
  var path = parsed.path;
  var sameNamespace = cache[id] && path in cache[id].nsps;
  var newConnection = opts.forceNew || opts['force new connection'] ||
                      false === opts.multiplex || sameNamespace;

  var io;

  if (newConnection) {
    debug('ignoring socket cache for %s', source);
    io = Manager(source, opts);
  } else {
    if (!cache[id]) {
      debug('new io instance for %s', source);
      cache[id] = Manager(source, opts);
    }
    io = cache[id];
  }
  if (parsed.query && !opts.query) {
    opts.query = parsed.query;
  }
  return io.socket(parsed.path, opts);
}

/**
 * Protocol version.
 *
 * @api public
 */

exports.protocol = parser.protocol;

/**
 * `connect`.
 *
 * @param {String} uri
 * @api public
 */

exports.connect = lookup;

/**
 * Expose constructors for standalone build.
 *
 * @api public
 */

exports.Manager = require('./manager');
exports.Socket = require('./socket');

},{"./manager":60,"./socket":62,"./url":63,"debug":64,"socket.io-parser":77}],60:[function(require,module,exports){

/**
 * Module dependencies.
 */

var eio = require('engine.io-client');
var Socket = require('./socket');
var Emitter = require('component-emitter');
var parser = require('socket.io-parser');
var on = require('./on');
var bind = require('component-bind');
var debug = require('debug')('socket.io-client:manager');
var indexOf = require('indexof');
var Backoff = require('backo2');

/**
 * IE6+ hasOwnProperty
 */

var has = Object.prototype.hasOwnProperty;

/**
 * Module exports
 */

module.exports = Manager;

/**
 * `Manager` constructor.
 *
 * @param {String} engine instance or engine uri/opts
 * @param {Object} options
 * @api public
 */

function Manager (uri, opts) {
  if (!(this instanceof Manager)) return new Manager(uri, opts);
  if (uri && ('object' === typeof uri)) {
    opts = uri;
    uri = undefined;
  }
  opts = opts || {};

  opts.path = opts.path || '/socket.io';
  this.nsps = {};
  this.subs = [];
  this.opts = opts;
  this.reconnection(opts.reconnection !== false);
  this.reconnectionAttempts(opts.reconnectionAttempts || Infinity);
  this.reconnectionDelay(opts.reconnectionDelay || 1000);
  this.reconnectionDelayMax(opts.reconnectionDelayMax || 5000);
  this.randomizationFactor(opts.randomizationFactor || 0.5);
  this.backoff = new Backoff({
    min: this.reconnectionDelay(),
    max: this.reconnectionDelayMax(),
    jitter: this.randomizationFactor()
  });
  this.timeout(null == opts.timeout ? 20000 : opts.timeout);
  this.readyState = 'closed';
  this.uri = uri;
  this.connecting = [];
  this.lastPing = null;
  this.encoding = false;
  this.packetBuffer = [];
  var _parser = opts.parser || parser;
  this.encoder = new _parser.Encoder();
  this.decoder = new _parser.Decoder();
  this.autoConnect = opts.autoConnect !== false;
  if (this.autoConnect) this.open();
}

/**
 * Propagate given event to sockets and emit on `this`
 *
 * @api private
 */

Manager.prototype.emitAll = function () {
  this.emit.apply(this, arguments);
  for (var nsp in this.nsps) {
    if (has.call(this.nsps, nsp)) {
      this.nsps[nsp].emit.apply(this.nsps[nsp], arguments);
    }
  }
};

/**
 * Update `socket.id` of all sockets
 *
 * @api private
 */

Manager.prototype.updateSocketIds = function () {
  for (var nsp in this.nsps) {
    if (has.call(this.nsps, nsp)) {
      this.nsps[nsp].id = this.generateId(nsp);
    }
  }
};

/**
 * generate `socket.id` for the given `nsp`
 *
 * @param {String} nsp
 * @return {String}
 * @api private
 */

Manager.prototype.generateId = function (nsp) {
  return (nsp === '/' ? '' : (nsp + '#')) + this.engine.id;
};

/**
 * Mix in `Emitter`.
 */

Emitter(Manager.prototype);

/**
 * Sets the `reconnection` config.
 *
 * @param {Boolean} true/false if it should automatically reconnect
 * @return {Manager} self or value
 * @api public
 */

Manager.prototype.reconnection = function (v) {
  if (!arguments.length) return this._reconnection;
  this._reconnection = !!v;
  return this;
};

/**
 * Sets the reconnection attempts config.
 *
 * @param {Number} max reconnection attempts before giving up
 * @return {Manager} self or value
 * @api public
 */

Manager.prototype.reconnectionAttempts = function (v) {
  if (!arguments.length) return this._reconnectionAttempts;
  this._reconnectionAttempts = v;
  return this;
};

/**
 * Sets the delay between reconnections.
 *
 * @param {Number} delay
 * @return {Manager} self or value
 * @api public
 */

Manager.prototype.reconnectionDelay = function (v) {
  if (!arguments.length) return this._reconnectionDelay;
  this._reconnectionDelay = v;
  this.backoff && this.backoff.setMin(v);
  return this;
};

Manager.prototype.randomizationFactor = function (v) {
  if (!arguments.length) return this._randomizationFactor;
  this._randomizationFactor = v;
  this.backoff && this.backoff.setJitter(v);
  return this;
};

/**
 * Sets the maximum delay between reconnections.
 *
 * @param {Number} delay
 * @return {Manager} self or value
 * @api public
 */

Manager.prototype.reconnectionDelayMax = function (v) {
  if (!arguments.length) return this._reconnectionDelayMax;
  this._reconnectionDelayMax = v;
  this.backoff && this.backoff.setMax(v);
  return this;
};

/**
 * Sets the connection timeout. `false` to disable
 *
 * @return {Manager} self or value
 * @api public
 */

Manager.prototype.timeout = function (v) {
  if (!arguments.length) return this._timeout;
  this._timeout = v;
  return this;
};

/**
 * Starts trying to reconnect if reconnection is enabled and we have not
 * started reconnecting yet
 *
 * @api private
 */

Manager.prototype.maybeReconnectOnOpen = function () {
  // Only try to reconnect if it's the first time we're connecting
  if (!this.reconnecting && this._reconnection && this.backoff.attempts === 0) {
    // keeps reconnection from firing twice for the same reconnection loop
    this.reconnect();
  }
};

/**
 * Sets the current transport `socket`.
 *
 * @param {Function} optional, callback
 * @return {Manager} self
 * @api public
 */

Manager.prototype.open =
Manager.prototype.connect = function (fn, opts) {
  debug('readyState %s', this.readyState);
  if (~this.readyState.indexOf('open')) return this;

  debug('opening %s', this.uri);
  this.engine = eio(this.uri, this.opts);
  var socket = this.engine;
  var self = this;
  this.readyState = 'opening';
  this.skipReconnect = false;

  // emit `open`
  var openSub = on(socket, 'open', function () {
    self.onopen();
    fn && fn();
  });

  // emit `connect_error`
  var errorSub = on(socket, 'error', function (data) {
    debug('connect_error');
    self.cleanup();
    self.readyState = 'closed';
    self.emitAll('connect_error', data);
    if (fn) {
      var err = new Error('Connection error');
      err.data = data;
      fn(err);
    } else {
      // Only do this if there is no fn to handle the error
      self.maybeReconnectOnOpen();
    }
  });

  // emit `connect_timeout`
  if (false !== this._timeout) {
    var timeout = this._timeout;
    debug('connect attempt will timeout after %d', timeout);

    // set timer
    var timer = setTimeout(function () {
      debug('connect attempt timed out after %d', timeout);
      openSub.destroy();
      socket.close();
      socket.emit('error', 'timeout');
      self.emitAll('connect_timeout', timeout);
    }, timeout);

    this.subs.push({
      destroy: function () {
        clearTimeout(timer);
      }
    });
  }

  this.subs.push(openSub);
  this.subs.push(errorSub);

  return this;
};

/**
 * Called upon transport open.
 *
 * @api private
 */

Manager.prototype.onopen = function () {
  debug('open');

  // clear old subs
  this.cleanup();

  // mark as open
  this.readyState = 'open';
  this.emit('open');

  // add new subs
  var socket = this.engine;
  this.subs.push(on(socket, 'data', bind(this, 'ondata')));
  this.subs.push(on(socket, 'ping', bind(this, 'onping')));
  this.subs.push(on(socket, 'pong', bind(this, 'onpong')));
  this.subs.push(on(socket, 'error', bind(this, 'onerror')));
  this.subs.push(on(socket, 'close', bind(this, 'onclose')));
  this.subs.push(on(this.decoder, 'decoded', bind(this, 'ondecoded')));
};

/**
 * Called upon a ping.
 *
 * @api private
 */

Manager.prototype.onping = function () {
  this.lastPing = new Date();
  this.emitAll('ping');
};

/**
 * Called upon a packet.
 *
 * @api private
 */

Manager.prototype.onpong = function () {
  this.emitAll('pong', new Date() - this.lastPing);
};

/**
 * Called with data.
 *
 * @api private
 */

Manager.prototype.ondata = function (data) {
  this.decoder.add(data);
};

/**
 * Called when parser fully decodes a packet.
 *
 * @api private
 */

Manager.prototype.ondecoded = function (packet) {
  this.emit('packet', packet);
};

/**
 * Called upon socket error.
 *
 * @api private
 */

Manager.prototype.onerror = function (err) {
  debug('error', err);
  this.emitAll('error', err);
};

/**
 * Creates a new socket for the given `nsp`.
 *
 * @return {Socket}
 * @api public
 */

Manager.prototype.socket = function (nsp, opts) {
  var socket = this.nsps[nsp];
  if (!socket) {
    socket = new Socket(this, nsp, opts);
    this.nsps[nsp] = socket;
    var self = this;
    socket.on('connecting', onConnecting);
    socket.on('connect', function () {
      socket.id = self.generateId(nsp);
    });

    if (this.autoConnect) {
      // manually call here since connecting event is fired before listening
      onConnecting();
    }
  }

  function onConnecting () {
    if (!~indexOf(self.connecting, socket)) {
      self.connecting.push(socket);
    }
  }

  return socket;
};

/**
 * Called upon a socket close.
 *
 * @param {Socket} socket
 */

Manager.prototype.destroy = function (socket) {
  var index = indexOf(this.connecting, socket);
  if (~index) this.connecting.splice(index, 1);
  if (this.connecting.length) return;

  this.close();
};

/**
 * Writes a packet.
 *
 * @param {Object} packet
 * @api private
 */

Manager.prototype.packet = function (packet) {
  debug('writing packet %j', packet);
  var self = this;
  if (packet.query && packet.type === 0) packet.nsp += '?' + packet.query;

  if (!self.encoding) {
    // encode, then write to engine with result
    self.encoding = true;
    this.encoder.encode(packet, function (encodedPackets) {
      for (var i = 0; i < encodedPackets.length; i++) {
        self.engine.write(encodedPackets[i], packet.options);
      }
      self.encoding = false;
      self.processPacketQueue();
    });
  } else { // add packet to the queue
    self.packetBuffer.push(packet);
  }
};

/**
 * If packet buffer is non-empty, begins encoding the
 * next packet in line.
 *
 * @api private
 */

Manager.prototype.processPacketQueue = function () {
  if (this.packetBuffer.length > 0 && !this.encoding) {
    var pack = this.packetBuffer.shift();
    this.packet(pack);
  }
};

/**
 * Clean up transport subscriptions and packet buffer.
 *
 * @api private
 */

Manager.prototype.cleanup = function () {
  debug('cleanup');

  var subsLength = this.subs.length;
  for (var i = 0; i < subsLength; i++) {
    var sub = this.subs.shift();
    sub.destroy();
  }

  this.packetBuffer = [];
  this.encoding = false;
  this.lastPing = null;

  this.decoder.destroy();
};

/**
 * Close the current socket.
 *
 * @api private
 */

Manager.prototype.close =
Manager.prototype.disconnect = function () {
  debug('disconnect');
  this.skipReconnect = true;
  this.reconnecting = false;
  if ('opening' === this.readyState) {
    // `onclose` will not fire because
    // an open event never happened
    this.cleanup();
  }
  this.backoff.reset();
  this.readyState = 'closed';
  if (this.engine) this.engine.close();
};

/**
 * Called upon engine close.
 *
 * @api private
 */

Manager.prototype.onclose = function (reason) {
  debug('onclose');

  this.cleanup();
  this.backoff.reset();
  this.readyState = 'closed';
  this.emit('close', reason);

  if (this._reconnection && !this.skipReconnect) {
    this.reconnect();
  }
};

/**
 * Attempt a reconnection.
 *
 * @api private
 */

Manager.prototype.reconnect = function () {
  if (this.reconnecting || this.skipReconnect) return this;

  var self = this;

  if (this.backoff.attempts >= this._reconnectionAttempts) {
    debug('reconnect failed');
    this.backoff.reset();
    this.emitAll('reconnect_failed');
    this.reconnecting = false;
  } else {
    var delay = this.backoff.duration();
    debug('will wait %dms before reconnect attempt', delay);

    this.reconnecting = true;
    var timer = setTimeout(function () {
      if (self.skipReconnect) return;

      debug('attempting reconnect');
      self.emitAll('reconnect_attempt', self.backoff.attempts);
      self.emitAll('reconnecting', self.backoff.attempts);

      // check again for the case socket closed in above events
      if (self.skipReconnect) return;

      self.open(function (err) {
        if (err) {
          debug('reconnect attempt error');
          self.reconnecting = false;
          self.reconnect();
          self.emitAll('reconnect_error', err.data);
        } else {
          debug('reconnect success');
          self.onreconnect();
        }
      });
    }, delay);

    this.subs.push({
      destroy: function () {
        clearTimeout(timer);
      }
    });
  }
};

/**
 * Called upon successful reconnect.
 *
 * @api private
 */

Manager.prototype.onreconnect = function () {
  var attempt = this.backoff.attempts;
  this.reconnecting = false;
  this.backoff.reset();
  this.updateSocketIds();
  this.emitAll('reconnect', attempt);
};

},{"./on":61,"./socket":62,"backo2":33,"component-bind":39,"component-emitter":40,"debug":64,"engine.io-client":66,"indexof":50,"socket.io-parser":77}],61:[function(require,module,exports){

/**
 * Module exports.
 */

module.exports = on;

/**
 * Helper for subscriptions.
 *
 * @param {Object|EventEmitter} obj with `Emitter` mixin or `EventEmitter`
 * @param {String} event name
 * @param {Function} callback
 * @api public
 */

function on (obj, ev, fn) {
  obj.on(ev, fn);
  return {
    destroy: function () {
      obj.removeListener(ev, fn);
    }
  };
}

},{}],62:[function(require,module,exports){

/**
 * Module dependencies.
 */

var parser = require('socket.io-parser');
var Emitter = require('component-emitter');
var toArray = require('to-array');
var on = require('./on');
var bind = require('component-bind');
var debug = require('debug')('socket.io-client:socket');
var parseqs = require('parseqs');
var hasBin = require('has-binary2');

/**
 * Module exports.
 */

module.exports = exports = Socket;

/**
 * Internal events (blacklisted).
 * These events can't be emitted by the user.
 *
 * @api private
 */

var events = {
  connect: 1,
  connect_error: 1,
  connect_timeout: 1,
  connecting: 1,
  disconnect: 1,
  error: 1,
  reconnect: 1,
  reconnect_attempt: 1,
  reconnect_failed: 1,
  reconnect_error: 1,
  reconnecting: 1,
  ping: 1,
  pong: 1
};

/**
 * Shortcut to `Emitter#emit`.
 */

var emit = Emitter.prototype.emit;

/**
 * `Socket` constructor.
 *
 * @api public
 */

function Socket (io, nsp, opts) {
  this.io = io;
  this.nsp = nsp;
  this.json = this; // compat
  this.ids = 0;
  this.acks = {};
  this.receiveBuffer = [];
  this.sendBuffer = [];
  this.connected = false;
  this.disconnected = true;
  this.flags = {};
  if (opts && opts.query) {
    this.query = opts.query;
  }
  if (this.io.autoConnect) this.open();
}

/**
 * Mix in `Emitter`.
 */

Emitter(Socket.prototype);

/**
 * Subscribe to open, close and packet events
 *
 * @api private
 */

Socket.prototype.subEvents = function () {
  if (this.subs) return;

  var io = this.io;
  this.subs = [
    on(io, 'open', bind(this, 'onopen')),
    on(io, 'packet', bind(this, 'onpacket')),
    on(io, 'close', bind(this, 'onclose'))
  ];
};

/**
 * "Opens" the socket.
 *
 * @api public
 */

Socket.prototype.open =
Socket.prototype.connect = function () {
  if (this.connected) return this;

  this.subEvents();
  this.io.open(); // ensure open
  if ('open' === this.io.readyState) this.onopen();
  this.emit('connecting');
  return this;
};

/**
 * Sends a `message` event.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.send = function () {
  var args = toArray(arguments);
  args.unshift('message');
  this.emit.apply(this, args);
  return this;
};

/**
 * Override `emit`.
 * If the event is in `events`, it's emitted normally.
 *
 * @param {String} event name
 * @return {Socket} self
 * @api public
 */

Socket.prototype.emit = function (ev) {
  if (events.hasOwnProperty(ev)) {
    emit.apply(this, arguments);
    return this;
  }

  var args = toArray(arguments);
  var packet = {
    type: (this.flags.binary !== undefined ? this.flags.binary : hasBin(args)) ? parser.BINARY_EVENT : parser.EVENT,
    data: args
  };

  packet.options = {};
  packet.options.compress = !this.flags || false !== this.flags.compress;

  // event ack callback
  if ('function' === typeof args[args.length - 1]) {
    debug('emitting packet with ack id %d', this.ids);
    this.acks[this.ids] = args.pop();
    packet.id = this.ids++;
  }

  if (this.connected) {
    this.packet(packet);
  } else {
    this.sendBuffer.push(packet);
  }

  this.flags = {};

  return this;
};

/**
 * Sends a packet.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.packet = function (packet) {
  packet.nsp = this.nsp;
  this.io.packet(packet);
};

/**
 * Called upon engine `open`.
 *
 * @api private
 */

Socket.prototype.onopen = function () {
  debug('transport is open - connecting');

  // write connect packet if necessary
  if ('/' !== this.nsp) {
    if (this.query) {
      var query = typeof this.query === 'object' ? parseqs.encode(this.query) : this.query;
      debug('sending connect packet with query %s', query);
      this.packet({type: parser.CONNECT, query: query});
    } else {
      this.packet({type: parser.CONNECT});
    }
  }
};

/**
 * Called upon engine `close`.
 *
 * @param {String} reason
 * @api private
 */

Socket.prototype.onclose = function (reason) {
  debug('close (%s)', reason);
  this.connected = false;
  this.disconnected = true;
  delete this.id;
  this.emit('disconnect', reason);
};

/**
 * Called with socket packet.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onpacket = function (packet) {
  var sameNamespace = packet.nsp === this.nsp;
  var rootNamespaceError = packet.type === parser.ERROR && packet.nsp === '/';

  if (!sameNamespace && !rootNamespaceError) return;

  switch (packet.type) {
    case parser.CONNECT:
      this.onconnect();
      break;

    case parser.EVENT:
      this.onevent(packet);
      break;

    case parser.BINARY_EVENT:
      this.onevent(packet);
      break;

    case parser.ACK:
      this.onack(packet);
      break;

    case parser.BINARY_ACK:
      this.onack(packet);
      break;

    case parser.DISCONNECT:
      this.ondisconnect();
      break;

    case parser.ERROR:
      this.emit('error', packet.data);
      break;
  }
};

/**
 * Called upon a server event.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onevent = function (packet) {
  var args = packet.data || [];
  debug('emitting event %j', args);

  if (null != packet.id) {
    debug('attaching ack callback to event');
    args.push(this.ack(packet.id));
  }

  if (this.connected) {
    emit.apply(this, args);
  } else {
    this.receiveBuffer.push(args);
  }
};

/**
 * Produces an ack callback to emit with an event.
 *
 * @api private
 */

Socket.prototype.ack = function (id) {
  var self = this;
  var sent = false;
  return function () {
    // prevent double callbacks
    if (sent) return;
    sent = true;
    var args = toArray(arguments);
    debug('sending ack %j', args);

    self.packet({
      type: hasBin(args) ? parser.BINARY_ACK : parser.ACK,
      id: id,
      data: args
    });
  };
};

/**
 * Called upon a server acknowlegement.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onack = function (packet) {
  var ack = this.acks[packet.id];
  if ('function' === typeof ack) {
    debug('calling ack %s with %j', packet.id, packet.data);
    ack.apply(this, packet.data);
    delete this.acks[packet.id];
  } else {
    debug('bad ack %s', packet.id);
  }
};

/**
 * Called upon server connect.
 *
 * @api private
 */

Socket.prototype.onconnect = function () {
  this.connected = true;
  this.disconnected = false;
  this.emit('connect');
  this.emitBuffered();
};

/**
 * Emit buffered events (received and emitted).
 *
 * @api private
 */

Socket.prototype.emitBuffered = function () {
  var i;
  for (i = 0; i < this.receiveBuffer.length; i++) {
    emit.apply(this, this.receiveBuffer[i]);
  }
  this.receiveBuffer = [];

  for (i = 0; i < this.sendBuffer.length; i++) {
    this.packet(this.sendBuffer[i]);
  }
  this.sendBuffer = [];
};

/**
 * Called upon server disconnect.
 *
 * @api private
 */

Socket.prototype.ondisconnect = function () {
  debug('server disconnect (%s)', this.nsp);
  this.destroy();
  this.onclose('io server disconnect');
};

/**
 * Called upon forced client/server side disconnections,
 * this method ensures the manager stops tracking us and
 * that reconnections don't get triggered for this.
 *
 * @api private.
 */

Socket.prototype.destroy = function () {
  if (this.subs) {
    // clean subscriptions to avoid reconnections
    for (var i = 0; i < this.subs.length; i++) {
      this.subs[i].destroy();
    }
    this.subs = null;
  }

  this.io.destroy(this);
};

/**
 * Disconnects the socket manually.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.close =
Socket.prototype.disconnect = function () {
  if (this.connected) {
    debug('performing disconnect (%s)', this.nsp);
    this.packet({ type: parser.DISCONNECT });
  }

  // remove socket from pool
  this.destroy();

  if (this.connected) {
    // fire events
    this.onclose('io client disconnect');
  }
  return this;
};

/**
 * Sets the compress flag.
 *
 * @param {Boolean} if `true`, compresses the sending data
 * @return {Socket} self
 * @api public
 */

Socket.prototype.compress = function (compress) {
  this.flags.compress = compress;
  return this;
};

/**
 * Sets the binary flag
 *
 * @param {Boolean} whether the emitted data contains binary
 * @return {Socket} self
 * @api public
 */

Socket.prototype.binary = function (binary) {
  this.flags.binary = binary;
  return this;
};

},{"./on":61,"component-bind":39,"component-emitter":40,"debug":64,"has-binary2":46,"parseqs":54,"socket.io-parser":77,"to-array":79}],63:[function(require,module,exports){

/**
 * Module dependencies.
 */

var parseuri = require('parseuri');
var debug = require('debug')('socket.io-client:url');

/**
 * Module exports.
 */

module.exports = url;

/**
 * URL parser.
 *
 * @param {String} url
 * @param {Object} An object meant to mimic window.location.
 *                 Defaults to window.location.
 * @api public
 */

function url (uri, loc) {
  var obj = uri;

  // default to window.location
  loc = loc || (typeof location !== 'undefined' && location);
  if (null == uri) uri = loc.protocol + '//' + loc.host;

  // relative path support
  if ('string' === typeof uri) {
    if ('/' === uri.charAt(0)) {
      if ('/' === uri.charAt(1)) {
        uri = loc.protocol + uri;
      } else {
        uri = loc.host + uri;
      }
    }

    if (!/^(https?|wss?):\/\//.test(uri)) {
      debug('protocol-less url %s', uri);
      if ('undefined' !== typeof loc) {
        uri = loc.protocol + '//' + uri;
      } else {
        uri = 'https://' + uri;
      }
    }

    // parse
    debug('parse %s', uri);
    obj = parseuri(uri);
  }

  // make sure we treat `localhost:80` and `localhost` equally
  if (!obj.port) {
    if (/^(http|ws)$/.test(obj.protocol)) {
      obj.port = '80';
    } else if (/^(http|ws)s$/.test(obj.protocol)) {
      obj.port = '443';
    }
  }

  obj.path = obj.path || '/';

  var ipv6 = obj.host.indexOf(':') !== -1;
  var host = ipv6 ? '[' + obj.host + ']' : obj.host;

  // define unique id
  obj.id = obj.protocol + '://' + host + ':' + obj.port;
  // define href
  obj.href = obj.protocol + '://' + host + (loc && loc.port === obj.port ? '' : (':' + obj.port));

  return obj;
}

},{"debug":64,"parseuri":55}],64:[function(require,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  '#0000CC', '#0000FF', '#0033CC', '#0033FF', '#0066CC', '#0066FF', '#0099CC',
  '#0099FF', '#00CC00', '#00CC33', '#00CC66', '#00CC99', '#00CCCC', '#00CCFF',
  '#3300CC', '#3300FF', '#3333CC', '#3333FF', '#3366CC', '#3366FF', '#3399CC',
  '#3399FF', '#33CC00', '#33CC33', '#33CC66', '#33CC99', '#33CCCC', '#33CCFF',
  '#6600CC', '#6600FF', '#6633CC', '#6633FF', '#66CC00', '#66CC33', '#9900CC',
  '#9900FF', '#9933CC', '#9933FF', '#99CC00', '#99CC33', '#CC0000', '#CC0033',
  '#CC0066', '#CC0099', '#CC00CC', '#CC00FF', '#CC3300', '#CC3333', '#CC3366',
  '#CC3399', '#CC33CC', '#CC33FF', '#CC6600', '#CC6633', '#CC9900', '#CC9933',
  '#CCCC00', '#CCCC33', '#FF0000', '#FF0033', '#FF0066', '#FF0099', '#FF00CC',
  '#FF00FF', '#FF3300', '#FF3333', '#FF3366', '#FF3399', '#FF33CC', '#FF33FF',
  '#FF6600', '#FF6633', '#FF9900', '#FF9933', '#FFCC00', '#FFCC33'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // Internet Explorer and Edge do not support colors.
  if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
    return false;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,require('_process'))
},{"./debug":65,"_process":56}],65:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * Active `debug` instances.
 */
exports.instances = [];

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  var prevTime;

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);
  debug.destroy = destroy;

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  exports.instances.push(debug);

  return debug;
}

function destroy () {
  var index = exports.instances.indexOf(this);
  if (index !== -1) {
    exports.instances.splice(index, 1);
    return true;
  } else {
    return false;
  }
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var i;
  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }

  for (i = 0; i < exports.instances.length; i++) {
    var instance = exports.instances[i];
    instance.enabled = exports.enabled(instance.namespace);
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  if (name[name.length - 1] === '*') {
    return true;
  }
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":53}],66:[function(require,module,exports){

module.exports = require('./socket');

/**
 * Exports parser
 *
 * @api public
 *
 */
module.exports.parser = require('engine.io-parser');

},{"./socket":67,"engine.io-parser":43}],67:[function(require,module,exports){
/**
 * Module dependencies.
 */

var transports = require('./transports/index');
var Emitter = require('component-emitter');
var debug = require('debug')('engine.io-client:socket');
var index = require('indexof');
var parser = require('engine.io-parser');
var parseuri = require('parseuri');
var parseqs = require('parseqs');

/**
 * Module exports.
 */

module.exports = Socket;

/**
 * Socket constructor.
 *
 * @param {String|Object} uri or options
 * @param {Object} options
 * @api public
 */

function Socket (uri, opts) {
  if (!(this instanceof Socket)) return new Socket(uri, opts);

  opts = opts || {};

  if (uri && 'object' === typeof uri) {
    opts = uri;
    uri = null;
  }

  if (uri) {
    uri = parseuri(uri);
    opts.hostname = uri.host;
    opts.secure = uri.protocol === 'https' || uri.protocol === 'wss';
    opts.port = uri.port;
    if (uri.query) opts.query = uri.query;
  } else if (opts.host) {
    opts.hostname = parseuri(opts.host).host;
  }

  this.secure = null != opts.secure ? opts.secure
    : (typeof location !== 'undefined' && 'https:' === location.protocol);

  if (opts.hostname && !opts.port) {
    // if no port is specified manually, use the protocol default
    opts.port = this.secure ? '443' : '80';
  }

  this.agent = opts.agent || false;
  this.hostname = opts.hostname ||
    (typeof location !== 'undefined' ? location.hostname : 'localhost');
  this.port = opts.port || (typeof location !== 'undefined' && location.port
      ? location.port
      : (this.secure ? 443 : 80));
  this.query = opts.query || {};
  if ('string' === typeof this.query) this.query = parseqs.decode(this.query);
  this.upgrade = false !== opts.upgrade;
  this.path = (opts.path || '/engine.io').replace(/\/$/, '') + '/';
  this.forceJSONP = !!opts.forceJSONP;
  this.jsonp = false !== opts.jsonp;
  this.forceBase64 = !!opts.forceBase64;
  this.enablesXDR = !!opts.enablesXDR;
  this.timestampParam = opts.timestampParam || 't';
  this.timestampRequests = opts.timestampRequests;
  this.transports = opts.transports || ['polling', 'websocket'];
  this.transportOptions = opts.transportOptions || {};
  this.readyState = '';
  this.writeBuffer = [];
  this.prevBufferLen = 0;
  this.policyPort = opts.policyPort || 843;
  this.rememberUpgrade = opts.rememberUpgrade || false;
  this.binaryType = null;
  this.onlyBinaryUpgrades = opts.onlyBinaryUpgrades;
  this.perMessageDeflate = false !== opts.perMessageDeflate ? (opts.perMessageDeflate || {}) : false;

  if (true === this.perMessageDeflate) this.perMessageDeflate = {};
  if (this.perMessageDeflate && null == this.perMessageDeflate.threshold) {
    this.perMessageDeflate.threshold = 1024;
  }

  // SSL options for Node.js client
  this.pfx = opts.pfx || null;
  this.key = opts.key || null;
  this.passphrase = opts.passphrase || null;
  this.cert = opts.cert || null;
  this.ca = opts.ca || null;
  this.ciphers = opts.ciphers || null;
  this.rejectUnauthorized = opts.rejectUnauthorized === undefined ? true : opts.rejectUnauthorized;
  this.forceNode = !!opts.forceNode;

  // detect ReactNative environment
  this.isReactNative = (typeof navigator !== 'undefined' && typeof navigator.product === 'string' && navigator.product.toLowerCase() === 'reactnative');

  // other options for Node.js or ReactNative client
  if (typeof self === 'undefined' || this.isReactNative) {
    if (opts.extraHeaders && Object.keys(opts.extraHeaders).length > 0) {
      this.extraHeaders = opts.extraHeaders;
    }

    if (opts.localAddress) {
      this.localAddress = opts.localAddress;
    }
  }

  // set on handshake
  this.id = null;
  this.upgrades = null;
  this.pingInterval = null;
  this.pingTimeout = null;

  // set on heartbeat
  this.pingIntervalTimer = null;
  this.pingTimeoutTimer = null;

  this.open();
}

Socket.priorWebsocketSuccess = false;

/**
 * Mix in `Emitter`.
 */

Emitter(Socket.prototype);

/**
 * Protocol version.
 *
 * @api public
 */

Socket.protocol = parser.protocol; // this is an int

/**
 * Expose deps for legacy compatibility
 * and standalone browser access.
 */

Socket.Socket = Socket;
Socket.Transport = require('./transport');
Socket.transports = require('./transports/index');
Socket.parser = require('engine.io-parser');

/**
 * Creates transport of the given type.
 *
 * @param {String} transport name
 * @return {Transport}
 * @api private
 */

Socket.prototype.createTransport = function (name) {
  debug('creating transport "%s"', name);
  var query = clone(this.query);

  // append engine.io protocol identifier
  query.EIO = parser.protocol;

  // transport name
  query.transport = name;

  // per-transport options
  var options = this.transportOptions[name] || {};

  // session id if we already have one
  if (this.id) query.sid = this.id;

  var transport = new transports[name]({
    query: query,
    socket: this,
    agent: options.agent || this.agent,
    hostname: options.hostname || this.hostname,
    port: options.port || this.port,
    secure: options.secure || this.secure,
    path: options.path || this.path,
    forceJSONP: options.forceJSONP || this.forceJSONP,
    jsonp: options.jsonp || this.jsonp,
    forceBase64: options.forceBase64 || this.forceBase64,
    enablesXDR: options.enablesXDR || this.enablesXDR,
    timestampRequests: options.timestampRequests || this.timestampRequests,
    timestampParam: options.timestampParam || this.timestampParam,
    policyPort: options.policyPort || this.policyPort,
    pfx: options.pfx || this.pfx,
    key: options.key || this.key,
    passphrase: options.passphrase || this.passphrase,
    cert: options.cert || this.cert,
    ca: options.ca || this.ca,
    ciphers: options.ciphers || this.ciphers,
    rejectUnauthorized: options.rejectUnauthorized || this.rejectUnauthorized,
    perMessageDeflate: options.perMessageDeflate || this.perMessageDeflate,
    extraHeaders: options.extraHeaders || this.extraHeaders,
    forceNode: options.forceNode || this.forceNode,
    localAddress: options.localAddress || this.localAddress,
    requestTimeout: options.requestTimeout || this.requestTimeout,
    protocols: options.protocols || void (0),
    isReactNative: this.isReactNative
  });

  return transport;
};

function clone (obj) {
  var o = {};
  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      o[i] = obj[i];
    }
  }
  return o;
}

/**
 * Initializes transport to use and starts probe.
 *
 * @api private
 */
Socket.prototype.open = function () {
  var transport;
  if (this.rememberUpgrade && Socket.priorWebsocketSuccess && this.transports.indexOf('websocket') !== -1) {
    transport = 'websocket';
  } else if (0 === this.transports.length) {
    // Emit error on next tick so it can be listened to
    var self = this;
    setTimeout(function () {
      self.emit('error', 'No transports available');
    }, 0);
    return;
  } else {
    transport = this.transports[0];
  }
  this.readyState = 'opening';

  // Retry with the next transport if the transport is disabled (jsonp: false)
  try {
    transport = this.createTransport(transport);
  } catch (e) {
    this.transports.shift();
    this.open();
    return;
  }

  transport.open();
  this.setTransport(transport);
};

/**
 * Sets the current transport. Disables the existing one (if any).
 *
 * @api private
 */

Socket.prototype.setTransport = function (transport) {
  debug('setting transport %s', transport.name);
  var self = this;

  if (this.transport) {
    debug('clearing existing transport %s', this.transport.name);
    this.transport.removeAllListeners();
  }

  // set up transport
  this.transport = transport;

  // set up transport listeners
  transport
  .on('drain', function () {
    self.onDrain();
  })
  .on('packet', function (packet) {
    self.onPacket(packet);
  })
  .on('error', function (e) {
    self.onError(e);
  })
  .on('close', function () {
    self.onClose('transport close');
  });
};

/**
 * Probes a transport.
 *
 * @param {String} transport name
 * @api private
 */

Socket.prototype.probe = function (name) {
  debug('probing transport "%s"', name);
  var transport = this.createTransport(name, { probe: 1 });
  var failed = false;
  var self = this;

  Socket.priorWebsocketSuccess = false;

  function onTransportOpen () {
    if (self.onlyBinaryUpgrades) {
      var upgradeLosesBinary = !this.supportsBinary && self.transport.supportsBinary;
      failed = failed || upgradeLosesBinary;
    }
    if (failed) return;

    debug('probe transport "%s" opened', name);
    transport.send([{ type: 'ping', data: 'probe' }]);
    transport.once('packet', function (msg) {
      if (failed) return;
      if ('pong' === msg.type && 'probe' === msg.data) {
        debug('probe transport "%s" pong', name);
        self.upgrading = true;
        self.emit('upgrading', transport);
        if (!transport) return;
        Socket.priorWebsocketSuccess = 'websocket' === transport.name;

        debug('pausing current transport "%s"', self.transport.name);
        self.transport.pause(function () {
          if (failed) return;
          if ('closed' === self.readyState) return;
          debug('changing transport and sending upgrade packet');

          cleanup();

          self.setTransport(transport);
          transport.send([{ type: 'upgrade' }]);
          self.emit('upgrade', transport);
          transport = null;
          self.upgrading = false;
          self.flush();
        });
      } else {
        debug('probe transport "%s" failed', name);
        var err = new Error('probe error');
        err.transport = transport.name;
        self.emit('upgradeError', err);
      }
    });
  }

  function freezeTransport () {
    if (failed) return;

    // Any callback called by transport should be ignored since now
    failed = true;

    cleanup();

    transport.close();
    transport = null;
  }

  // Handle any error that happens while probing
  function onerror (err) {
    var error = new Error('probe error: ' + err);
    error.transport = transport.name;

    freezeTransport();

    debug('probe transport "%s" failed because of error: %s', name, err);

    self.emit('upgradeError', error);
  }

  function onTransportClose () {
    onerror('transport closed');
  }

  // When the socket is closed while we're probing
  function onclose () {
    onerror('socket closed');
  }

  // When the socket is upgraded while we're probing
  function onupgrade (to) {
    if (transport && to.name !== transport.name) {
      debug('"%s" works - aborting "%s"', to.name, transport.name);
      freezeTransport();
    }
  }

  // Remove all listeners on the transport and on self
  function cleanup () {
    transport.removeListener('open', onTransportOpen);
    transport.removeListener('error', onerror);
    transport.removeListener('close', onTransportClose);
    self.removeListener('close', onclose);
    self.removeListener('upgrading', onupgrade);
  }

  transport.once('open', onTransportOpen);
  transport.once('error', onerror);
  transport.once('close', onTransportClose);

  this.once('close', onclose);
  this.once('upgrading', onupgrade);

  transport.open();
};

/**
 * Called when connection is deemed open.
 *
 * @api public
 */

Socket.prototype.onOpen = function () {
  debug('socket open');
  this.readyState = 'open';
  Socket.priorWebsocketSuccess = 'websocket' === this.transport.name;
  this.emit('open');
  this.flush();

  // we check for `readyState` in case an `open`
  // listener already closed the socket
  if ('open' === this.readyState && this.upgrade && this.transport.pause) {
    debug('starting upgrade probes');
    for (var i = 0, l = this.upgrades.length; i < l; i++) {
      this.probe(this.upgrades[i]);
    }
  }
};

/**
 * Handles a packet.
 *
 * @api private
 */

Socket.prototype.onPacket = function (packet) {
  if ('opening' === this.readyState || 'open' === this.readyState ||
      'closing' === this.readyState) {
    debug('socket receive: type "%s", data "%s"', packet.type, packet.data);

    this.emit('packet', packet);

    // Socket is live - any packet counts
    this.emit('heartbeat');

    switch (packet.type) {
      case 'open':
        this.onHandshake(JSON.parse(packet.data));
        break;

      case 'pong':
        this.setPing();
        this.emit('pong');
        break;

      case 'error':
        var err = new Error('server error');
        err.code = packet.data;
        this.onError(err);
        break;

      case 'message':
        this.emit('data', packet.data);
        this.emit('message', packet.data);
        break;
    }
  } else {
    debug('packet received with socket readyState "%s"', this.readyState);
  }
};

/**
 * Called upon handshake completion.
 *
 * @param {Object} handshake obj
 * @api private
 */

Socket.prototype.onHandshake = function (data) {
  this.emit('handshake', data);
  this.id = data.sid;
  this.transport.query.sid = data.sid;
  this.upgrades = this.filterUpgrades(data.upgrades);
  this.pingInterval = data.pingInterval;
  this.pingTimeout = data.pingTimeout;
  this.onOpen();
  // In case open handler closes socket
  if ('closed' === this.readyState) return;
  this.setPing();

  // Prolong liveness of socket on heartbeat
  this.removeListener('heartbeat', this.onHeartbeat);
  this.on('heartbeat', this.onHeartbeat);
};

/**
 * Resets ping timeout.
 *
 * @api private
 */

Socket.prototype.onHeartbeat = function (timeout) {
  clearTimeout(this.pingTimeoutTimer);
  var self = this;
  self.pingTimeoutTimer = setTimeout(function () {
    if ('closed' === self.readyState) return;
    self.onClose('ping timeout');
  }, timeout || (self.pingInterval + self.pingTimeout));
};

/**
 * Pings server every `this.pingInterval` and expects response
 * within `this.pingTimeout` or closes connection.
 *
 * @api private
 */

Socket.prototype.setPing = function () {
  var self = this;
  clearTimeout(self.pingIntervalTimer);
  self.pingIntervalTimer = setTimeout(function () {
    debug('writing ping packet - expecting pong within %sms', self.pingTimeout);
    self.ping();
    self.onHeartbeat(self.pingTimeout);
  }, self.pingInterval);
};

/**
* Sends a ping packet.
*
* @api private
*/

Socket.prototype.ping = function () {
  var self = this;
  this.sendPacket('ping', function () {
    self.emit('ping');
  });
};

/**
 * Called on `drain` event
 *
 * @api private
 */

Socket.prototype.onDrain = function () {
  this.writeBuffer.splice(0, this.prevBufferLen);

  // setting prevBufferLen = 0 is very important
  // for example, when upgrading, upgrade packet is sent over,
  // and a nonzero prevBufferLen could cause problems on `drain`
  this.prevBufferLen = 0;

  if (0 === this.writeBuffer.length) {
    this.emit('drain');
  } else {
    this.flush();
  }
};

/**
 * Flush write buffers.
 *
 * @api private
 */

Socket.prototype.flush = function () {
  if ('closed' !== this.readyState && this.transport.writable &&
    !this.upgrading && this.writeBuffer.length) {
    debug('flushing %d packets in socket', this.writeBuffer.length);
    this.transport.send(this.writeBuffer);
    // keep track of current length of writeBuffer
    // splice writeBuffer and callbackBuffer on `drain`
    this.prevBufferLen = this.writeBuffer.length;
    this.emit('flush');
  }
};

/**
 * Sends a message.
 *
 * @param {String} message.
 * @param {Function} callback function.
 * @param {Object} options.
 * @return {Socket} for chaining.
 * @api public
 */

Socket.prototype.write =
Socket.prototype.send = function (msg, options, fn) {
  this.sendPacket('message', msg, options, fn);
  return this;
};

/**
 * Sends a packet.
 *
 * @param {String} packet type.
 * @param {String} data.
 * @param {Object} options.
 * @param {Function} callback function.
 * @api private
 */

Socket.prototype.sendPacket = function (type, data, options, fn) {
  if ('function' === typeof data) {
    fn = data;
    data = undefined;
  }

  if ('function' === typeof options) {
    fn = options;
    options = null;
  }

  if ('closing' === this.readyState || 'closed' === this.readyState) {
    return;
  }

  options = options || {};
  options.compress = false !== options.compress;

  var packet = {
    type: type,
    data: data,
    options: options
  };
  this.emit('packetCreate', packet);
  this.writeBuffer.push(packet);
  if (fn) this.once('flush', fn);
  this.flush();
};

/**
 * Closes the connection.
 *
 * @api private
 */

Socket.prototype.close = function () {
  if ('opening' === this.readyState || 'open' === this.readyState) {
    this.readyState = 'closing';

    var self = this;

    if (this.writeBuffer.length) {
      this.once('drain', function () {
        if (this.upgrading) {
          waitForUpgrade();
        } else {
          close();
        }
      });
    } else if (this.upgrading) {
      waitForUpgrade();
    } else {
      close();
    }
  }

  function close () {
    self.onClose('forced close');
    debug('socket closing - telling transport to close');
    self.transport.close();
  }

  function cleanupAndClose () {
    self.removeListener('upgrade', cleanupAndClose);
    self.removeListener('upgradeError', cleanupAndClose);
    close();
  }

  function waitForUpgrade () {
    // wait for upgrade to finish since we can't send packets while pausing a transport
    self.once('upgrade', cleanupAndClose);
    self.once('upgradeError', cleanupAndClose);
  }

  return this;
};

/**
 * Called upon transport error
 *
 * @api private
 */

Socket.prototype.onError = function (err) {
  debug('socket error %j', err);
  Socket.priorWebsocketSuccess = false;
  this.emit('error', err);
  this.onClose('transport error', err);
};

/**
 * Called upon transport close.
 *
 * @api private
 */

Socket.prototype.onClose = function (reason, desc) {
  if ('opening' === this.readyState || 'open' === this.readyState || 'closing' === this.readyState) {
    debug('socket close with reason: "%s"', reason);
    var self = this;

    // clear timers
    clearTimeout(this.pingIntervalTimer);
    clearTimeout(this.pingTimeoutTimer);

    // stop event from firing again for transport
    this.transport.removeAllListeners('close');

    // ensure transport won't stay open
    this.transport.close();

    // ignore further transport communication
    this.transport.removeAllListeners();

    // set ready state
    this.readyState = 'closed';

    // clear session id
    this.id = null;

    // emit close event
    this.emit('close', reason, desc);

    // clean buffers after, so users can still
    // grab the buffers on `close` event
    self.writeBuffer = [];
    self.prevBufferLen = 0;
  }
};

/**
 * Filters upgrades, returning only those matching client transports.
 *
 * @param {Array} server upgrades
 * @api private
 *
 */

Socket.prototype.filterUpgrades = function (upgrades) {
  var filteredUpgrades = [];
  for (var i = 0, j = upgrades.length; i < j; i++) {
    if (~index(this.transports, upgrades[i])) filteredUpgrades.push(upgrades[i]);
  }
  return filteredUpgrades;
};

},{"./transport":68,"./transports/index":69,"component-emitter":40,"debug":64,"engine.io-parser":43,"indexof":50,"parseqs":54,"parseuri":55}],68:[function(require,module,exports){
/**
 * Module dependencies.
 */

var parser = require('engine.io-parser');
var Emitter = require('component-emitter');

/**
 * Module exports.
 */

module.exports = Transport;

/**
 * Transport abstract constructor.
 *
 * @param {Object} options.
 * @api private
 */

function Transport (opts) {
  this.path = opts.path;
  this.hostname = opts.hostname;
  this.port = opts.port;
  this.secure = opts.secure;
  this.query = opts.query;
  this.timestampParam = opts.timestampParam;
  this.timestampRequests = opts.timestampRequests;
  this.readyState = '';
  this.agent = opts.agent || false;
  this.socket = opts.socket;
  this.enablesXDR = opts.enablesXDR;

  // SSL options for Node.js client
  this.pfx = opts.pfx;
  this.key = opts.key;
  this.passphrase = opts.passphrase;
  this.cert = opts.cert;
  this.ca = opts.ca;
  this.ciphers = opts.ciphers;
  this.rejectUnauthorized = opts.rejectUnauthorized;
  this.forceNode = opts.forceNode;

  // results of ReactNative environment detection
  this.isReactNative = opts.isReactNative;

  // other options for Node.js client
  this.extraHeaders = opts.extraHeaders;
  this.localAddress = opts.localAddress;
}

/**
 * Mix in `Emitter`.
 */

Emitter(Transport.prototype);

/**
 * Emits an error.
 *
 * @param {String} str
 * @return {Transport} for chaining
 * @api public
 */

Transport.prototype.onError = function (msg, desc) {
  var err = new Error(msg);
  err.type = 'TransportError';
  err.description = desc;
  this.emit('error', err);
  return this;
};

/**
 * Opens the transport.
 *
 * @api public
 */

Transport.prototype.open = function () {
  if ('closed' === this.readyState || '' === this.readyState) {
    this.readyState = 'opening';
    this.doOpen();
  }

  return this;
};

/**
 * Closes the transport.
 *
 * @api private
 */

Transport.prototype.close = function () {
  if ('opening' === this.readyState || 'open' === this.readyState) {
    this.doClose();
    this.onClose();
  }

  return this;
};

/**
 * Sends multiple packets.
 *
 * @param {Array} packets
 * @api private
 */

Transport.prototype.send = function (packets) {
  if ('open' === this.readyState) {
    this.write(packets);
  } else {
    throw new Error('Transport not open');
  }
};

/**
 * Called upon open
 *
 * @api private
 */

Transport.prototype.onOpen = function () {
  this.readyState = 'open';
  this.writable = true;
  this.emit('open');
};

/**
 * Called with data.
 *
 * @param {String} data
 * @api private
 */

Transport.prototype.onData = function (data) {
  var packet = parser.decodePacket(data, this.socket.binaryType);
  this.onPacket(packet);
};

/**
 * Called with a decoded packet.
 */

Transport.prototype.onPacket = function (packet) {
  this.emit('packet', packet);
};

/**
 * Called upon close.
 *
 * @api private
 */

Transport.prototype.onClose = function () {
  this.readyState = 'closed';
  this.emit('close');
};

},{"component-emitter":40,"engine.io-parser":43}],69:[function(require,module,exports){
/**
 * Module dependencies
 */

var XMLHttpRequest = require('xmlhttprequest-ssl');
var XHR = require('./polling-xhr');
var JSONP = require('./polling-jsonp');
var websocket = require('./websocket');

/**
 * Export transports.
 */

exports.polling = polling;
exports.websocket = websocket;

/**
 * Polling transport polymorphic constructor.
 * Decides on xhr vs jsonp based on feature detection.
 *
 * @api private
 */

function polling (opts) {
  var xhr;
  var xd = false;
  var xs = false;
  var jsonp = false !== opts.jsonp;

  if (typeof location !== 'undefined') {
    var isSSL = 'https:' === location.protocol;
    var port = location.port;

    // some user agents have empty `location.port`
    if (!port) {
      port = isSSL ? 443 : 80;
    }

    xd = opts.hostname !== location.hostname || port !== opts.port;
    xs = opts.secure !== isSSL;
  }

  opts.xdomain = xd;
  opts.xscheme = xs;
  xhr = new XMLHttpRequest(opts);

  if ('open' in xhr && !opts.forceJSONP) {
    return new XHR(opts);
  } else {
    if (!jsonp) throw new Error('JSONP disabled');
    return new JSONP(opts);
  }
}

},{"./polling-jsonp":70,"./polling-xhr":71,"./websocket":73,"xmlhttprequest-ssl":74}],70:[function(require,module,exports){
(function (global){
/**
 * Module requirements.
 */

var Polling = require('./polling');
var inherit = require('component-inherit');

/**
 * Module exports.
 */

module.exports = JSONPPolling;

/**
 * Cached regular expressions.
 */

var rNewline = /\n/g;
var rEscapedNewline = /\\n/g;

/**
 * Global JSONP callbacks.
 */

var callbacks;

/**
 * Noop.
 */

function empty () { }

/**
 * Until https://github.com/tc39/proposal-global is shipped.
 */
function glob () {
  return typeof self !== 'undefined' ? self
      : typeof window !== 'undefined' ? window
      : typeof global !== 'undefined' ? global : {};
}

/**
 * JSONP Polling constructor.
 *
 * @param {Object} opts.
 * @api public
 */

function JSONPPolling (opts) {
  Polling.call(this, opts);

  this.query = this.query || {};

  // define global callbacks array if not present
  // we do this here (lazily) to avoid unneeded global pollution
  if (!callbacks) {
    // we need to consider multiple engines in the same page
    var global = glob();
    callbacks = global.___eio = (global.___eio || []);
  }

  // callback identifier
  this.index = callbacks.length;

  // add callback to jsonp global
  var self = this;
  callbacks.push(function (msg) {
    self.onData(msg);
  });

  // append to query string
  this.query.j = this.index;

  // prevent spurious errors from being emitted when the window is unloaded
  if (typeof addEventListener === 'function') {
    addEventListener('beforeunload', function () {
      if (self.script) self.script.onerror = empty;
    }, false);
  }
}

/**
 * Inherits from Polling.
 */

inherit(JSONPPolling, Polling);

/*
 * JSONP only supports binary as base64 encoded strings
 */

JSONPPolling.prototype.supportsBinary = false;

/**
 * Closes the socket.
 *
 * @api private
 */

JSONPPolling.prototype.doClose = function () {
  if (this.script) {
    this.script.parentNode.removeChild(this.script);
    this.script = null;
  }

  if (this.form) {
    this.form.parentNode.removeChild(this.form);
    this.form = null;
    this.iframe = null;
  }

  Polling.prototype.doClose.call(this);
};

/**
 * Starts a poll cycle.
 *
 * @api private
 */

JSONPPolling.prototype.doPoll = function () {
  var self = this;
  var script = document.createElement('script');

  if (this.script) {
    this.script.parentNode.removeChild(this.script);
    this.script = null;
  }

  script.async = true;
  script.src = this.uri();
  script.onerror = function (e) {
    self.onError('jsonp poll error', e);
  };

  var insertAt = document.getElementsByTagName('script')[0];
  if (insertAt) {
    insertAt.parentNode.insertBefore(script, insertAt);
  } else {
    (document.head || document.body).appendChild(script);
  }
  this.script = script;

  var isUAgecko = 'undefined' !== typeof navigator && /gecko/i.test(navigator.userAgent);

  if (isUAgecko) {
    setTimeout(function () {
      var iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      document.body.removeChild(iframe);
    }, 100);
  }
};

/**
 * Writes with a hidden iframe.
 *
 * @param {String} data to send
 * @param {Function} called upon flush.
 * @api private
 */

JSONPPolling.prototype.doWrite = function (data, fn) {
  var self = this;

  if (!this.form) {
    var form = document.createElement('form');
    var area = document.createElement('textarea');
    var id = this.iframeId = 'eio_iframe_' + this.index;
    var iframe;

    form.className = 'socketio';
    form.style.position = 'absolute';
    form.style.top = '-1000px';
    form.style.left = '-1000px';
    form.target = id;
    form.method = 'POST';
    form.setAttribute('accept-charset', 'utf-8');
    area.name = 'd';
    form.appendChild(area);
    document.body.appendChild(form);

    this.form = form;
    this.area = area;
  }

  this.form.action = this.uri();

  function complete () {
    initIframe();
    fn();
  }

  function initIframe () {
    if (self.iframe) {
      try {
        self.form.removeChild(self.iframe);
      } catch (e) {
        self.onError('jsonp polling iframe removal error', e);
      }
    }

    try {
      // ie6 dynamic iframes with target="" support (thanks Chris Lambacher)
      var html = '<iframe src="javascript:0" name="' + self.iframeId + '">';
      iframe = document.createElement(html);
    } catch (e) {
      iframe = document.createElement('iframe');
      iframe.name = self.iframeId;
      iframe.src = 'javascript:0';
    }

    iframe.id = self.iframeId;

    self.form.appendChild(iframe);
    self.iframe = iframe;
  }

  initIframe();

  // escape \n to prevent it from being converted into \r\n by some UAs
  // double escaping is required for escaped new lines because unescaping of new lines can be done safely on server-side
  data = data.replace(rEscapedNewline, '\\\n');
  this.area.value = data.replace(rNewline, '\\n');

  try {
    this.form.submit();
  } catch (e) {}

  if (this.iframe.attachEvent) {
    this.iframe.onreadystatechange = function () {
      if (self.iframe.readyState === 'complete') {
        complete();
      }
    };
  } else {
    this.iframe.onload = complete;
  }
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./polling":72,"component-inherit":41}],71:[function(require,module,exports){
/* global attachEvent */

/**
 * Module requirements.
 */

var XMLHttpRequest = require('xmlhttprequest-ssl');
var Polling = require('./polling');
var Emitter = require('component-emitter');
var inherit = require('component-inherit');
var debug = require('debug')('engine.io-client:polling-xhr');

/**
 * Module exports.
 */

module.exports = XHR;
module.exports.Request = Request;

/**
 * Empty function
 */

function empty () {}

/**
 * XHR Polling constructor.
 *
 * @param {Object} opts
 * @api public
 */

function XHR (opts) {
  Polling.call(this, opts);
  this.requestTimeout = opts.requestTimeout;
  this.extraHeaders = opts.extraHeaders;

  if (typeof location !== 'undefined') {
    var isSSL = 'https:' === location.protocol;
    var port = location.port;

    // some user agents have empty `location.port`
    if (!port) {
      port = isSSL ? 443 : 80;
    }

    this.xd = (typeof location !== 'undefined' && opts.hostname !== location.hostname) ||
      port !== opts.port;
    this.xs = opts.secure !== isSSL;
  }
}

/**
 * Inherits from Polling.
 */

inherit(XHR, Polling);

/**
 * XHR supports binary
 */

XHR.prototype.supportsBinary = true;

/**
 * Creates a request.
 *
 * @param {String} method
 * @api private
 */

XHR.prototype.request = function (opts) {
  opts = opts || {};
  opts.uri = this.uri();
  opts.xd = this.xd;
  opts.xs = this.xs;
  opts.agent = this.agent || false;
  opts.supportsBinary = this.supportsBinary;
  opts.enablesXDR = this.enablesXDR;

  // SSL options for Node.js client
  opts.pfx = this.pfx;
  opts.key = this.key;
  opts.passphrase = this.passphrase;
  opts.cert = this.cert;
  opts.ca = this.ca;
  opts.ciphers = this.ciphers;
  opts.rejectUnauthorized = this.rejectUnauthorized;
  opts.requestTimeout = this.requestTimeout;

  // other options for Node.js client
  opts.extraHeaders = this.extraHeaders;

  return new Request(opts);
};

/**
 * Sends data.
 *
 * @param {String} data to send.
 * @param {Function} called upon flush.
 * @api private
 */

XHR.prototype.doWrite = function (data, fn) {
  var isBinary = typeof data !== 'string' && data !== undefined;
  var req = this.request({ method: 'POST', data: data, isBinary: isBinary });
  var self = this;
  req.on('success', fn);
  req.on('error', function (err) {
    self.onError('xhr post error', err);
  });
  this.sendXhr = req;
};

/**
 * Starts a poll cycle.
 *
 * @api private
 */

XHR.prototype.doPoll = function () {
  debug('xhr poll');
  var req = this.request();
  var self = this;
  req.on('data', function (data) {
    self.onData(data);
  });
  req.on('error', function (err) {
    self.onError('xhr poll error', err);
  });
  this.pollXhr = req;
};

/**
 * Request constructor
 *
 * @param {Object} options
 * @api public
 */

function Request (opts) {
  this.method = opts.method || 'GET';
  this.uri = opts.uri;
  this.xd = !!opts.xd;
  this.xs = !!opts.xs;
  this.async = false !== opts.async;
  this.data = undefined !== opts.data ? opts.data : null;
  this.agent = opts.agent;
  this.isBinary = opts.isBinary;
  this.supportsBinary = opts.supportsBinary;
  this.enablesXDR = opts.enablesXDR;
  this.requestTimeout = opts.requestTimeout;

  // SSL options for Node.js client
  this.pfx = opts.pfx;
  this.key = opts.key;
  this.passphrase = opts.passphrase;
  this.cert = opts.cert;
  this.ca = opts.ca;
  this.ciphers = opts.ciphers;
  this.rejectUnauthorized = opts.rejectUnauthorized;

  // other options for Node.js client
  this.extraHeaders = opts.extraHeaders;

  this.create();
}

/**
 * Mix in `Emitter`.
 */

Emitter(Request.prototype);

/**
 * Creates the XHR object and sends the request.
 *
 * @api private
 */

Request.prototype.create = function () {
  var opts = { agent: this.agent, xdomain: this.xd, xscheme: this.xs, enablesXDR: this.enablesXDR };

  // SSL options for Node.js client
  opts.pfx = this.pfx;
  opts.key = this.key;
  opts.passphrase = this.passphrase;
  opts.cert = this.cert;
  opts.ca = this.ca;
  opts.ciphers = this.ciphers;
  opts.rejectUnauthorized = this.rejectUnauthorized;

  var xhr = this.xhr = new XMLHttpRequest(opts);
  var self = this;

  try {
    debug('xhr open %s: %s', this.method, this.uri);
    xhr.open(this.method, this.uri, this.async);
    try {
      if (this.extraHeaders) {
        xhr.setDisableHeaderCheck && xhr.setDisableHeaderCheck(true);
        for (var i in this.extraHeaders) {
          if (this.extraHeaders.hasOwnProperty(i)) {
            xhr.setRequestHeader(i, this.extraHeaders[i]);
          }
        }
      }
    } catch (e) {}

    if ('POST' === this.method) {
      try {
        if (this.isBinary) {
          xhr.setRequestHeader('Content-type', 'application/octet-stream');
        } else {
          xhr.setRequestHeader('Content-type', 'text/plain;charset=UTF-8');
        }
      } catch (e) {}
    }

    try {
      xhr.setRequestHeader('Accept', '*/*');
    } catch (e) {}

    // ie6 check
    if ('withCredentials' in xhr) {
      xhr.withCredentials = true;
    }

    if (this.requestTimeout) {
      xhr.timeout = this.requestTimeout;
    }

    if (this.hasXDR()) {
      xhr.onload = function () {
        self.onLoad();
      };
      xhr.onerror = function () {
        self.onError(xhr.responseText);
      };
    } else {
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2) {
          try {
            var contentType = xhr.getResponseHeader('Content-Type');
            if (self.supportsBinary && contentType === 'application/octet-stream') {
              xhr.responseType = 'arraybuffer';
            }
          } catch (e) {}
        }
        if (4 !== xhr.readyState) return;
        if (200 === xhr.status || 1223 === xhr.status) {
          self.onLoad();
        } else {
          // make sure the `error` event handler that's user-set
          // does not throw in the same tick and gets caught here
          setTimeout(function () {
            self.onError(xhr.status);
          }, 0);
        }
      };
    }

    debug('xhr data %s', this.data);
    xhr.send(this.data);
  } catch (e) {
    // Need to defer since .create() is called directly fhrom the constructor
    // and thus the 'error' event can only be only bound *after* this exception
    // occurs.  Therefore, also, we cannot throw here at all.
    setTimeout(function () {
      self.onError(e);
    }, 0);
    return;
  }

  if (typeof document !== 'undefined') {
    this.index = Request.requestsCount++;
    Request.requests[this.index] = this;
  }
};

/**
 * Called upon successful response.
 *
 * @api private
 */

Request.prototype.onSuccess = function () {
  this.emit('success');
  this.cleanup();
};

/**
 * Called if we have data.
 *
 * @api private
 */

Request.prototype.onData = function (data) {
  this.emit('data', data);
  this.onSuccess();
};

/**
 * Called upon error.
 *
 * @api private
 */

Request.prototype.onError = function (err) {
  this.emit('error', err);
  this.cleanup(true);
};

/**
 * Cleans up house.
 *
 * @api private
 */

Request.prototype.cleanup = function (fromError) {
  if ('undefined' === typeof this.xhr || null === this.xhr) {
    return;
  }
  // xmlhttprequest
  if (this.hasXDR()) {
    this.xhr.onload = this.xhr.onerror = empty;
  } else {
    this.xhr.onreadystatechange = empty;
  }

  if (fromError) {
    try {
      this.xhr.abort();
    } catch (e) {}
  }

  if (typeof document !== 'undefined') {
    delete Request.requests[this.index];
  }

  this.xhr = null;
};

/**
 * Called upon load.
 *
 * @api private
 */

Request.prototype.onLoad = function () {
  var data;
  try {
    var contentType;
    try {
      contentType = this.xhr.getResponseHeader('Content-Type');
    } catch (e) {}
    if (contentType === 'application/octet-stream') {
      data = this.xhr.response || this.xhr.responseText;
    } else {
      data = this.xhr.responseText;
    }
  } catch (e) {
    this.onError(e);
  }
  if (null != data) {
    this.onData(data);
  }
};

/**
 * Check if it has XDomainRequest.
 *
 * @api private
 */

Request.prototype.hasXDR = function () {
  return typeof XDomainRequest !== 'undefined' && !this.xs && this.enablesXDR;
};

/**
 * Aborts the request.
 *
 * @api public
 */

Request.prototype.abort = function () {
  this.cleanup();
};

/**
 * Aborts pending requests when unloading the window. This is needed to prevent
 * memory leaks (e.g. when using IE) and to ensure that no spurious error is
 * emitted.
 */

Request.requestsCount = 0;
Request.requests = {};

if (typeof document !== 'undefined') {
  if (typeof attachEvent === 'function') {
    attachEvent('onunload', unloadHandler);
  } else if (typeof addEventListener === 'function') {
    var terminationEvent = 'onpagehide' in self ? 'pagehide' : 'unload';
    addEventListener(terminationEvent, unloadHandler, false);
  }
}

function unloadHandler () {
  for (var i in Request.requests) {
    if (Request.requests.hasOwnProperty(i)) {
      Request.requests[i].abort();
    }
  }
}

},{"./polling":72,"component-emitter":40,"component-inherit":41,"debug":64,"xmlhttprequest-ssl":74}],72:[function(require,module,exports){
/**
 * Module dependencies.
 */

var Transport = require('../transport');
var parseqs = require('parseqs');
var parser = require('engine.io-parser');
var inherit = require('component-inherit');
var yeast = require('yeast');
var debug = require('debug')('engine.io-client:polling');

/**
 * Module exports.
 */

module.exports = Polling;

/**
 * Is XHR2 supported?
 */

var hasXHR2 = (function () {
  var XMLHttpRequest = require('xmlhttprequest-ssl');
  var xhr = new XMLHttpRequest({ xdomain: false });
  return null != xhr.responseType;
})();

/**
 * Polling interface.
 *
 * @param {Object} opts
 * @api private
 */

function Polling (opts) {
  var forceBase64 = (opts && opts.forceBase64);
  if (!hasXHR2 || forceBase64) {
    this.supportsBinary = false;
  }
  Transport.call(this, opts);
}

/**
 * Inherits from Transport.
 */

inherit(Polling, Transport);

/**
 * Transport name.
 */

Polling.prototype.name = 'polling';

/**
 * Opens the socket (triggers polling). We write a PING message to determine
 * when the transport is open.
 *
 * @api private
 */

Polling.prototype.doOpen = function () {
  this.poll();
};

/**
 * Pauses polling.
 *
 * @param {Function} callback upon buffers are flushed and transport is paused
 * @api private
 */

Polling.prototype.pause = function (onPause) {
  var self = this;

  this.readyState = 'pausing';

  function pause () {
    debug('paused');
    self.readyState = 'paused';
    onPause();
  }

  if (this.polling || !this.writable) {
    var total = 0;

    if (this.polling) {
      debug('we are currently polling - waiting to pause');
      total++;
      this.once('pollComplete', function () {
        debug('pre-pause polling complete');
        --total || pause();
      });
    }

    if (!this.writable) {
      debug('we are currently writing - waiting to pause');
      total++;
      this.once('drain', function () {
        debug('pre-pause writing complete');
        --total || pause();
      });
    }
  } else {
    pause();
  }
};

/**
 * Starts polling cycle.
 *
 * @api public
 */

Polling.prototype.poll = function () {
  debug('polling');
  this.polling = true;
  this.doPoll();
  this.emit('poll');
};

/**
 * Overloads onData to detect payloads.
 *
 * @api private
 */

Polling.prototype.onData = function (data) {
  var self = this;
  debug('polling got data %s', data);
  var callback = function (packet, index, total) {
    // if its the first message we consider the transport open
    if ('opening' === self.readyState) {
      self.onOpen();
    }

    // if its a close packet, we close the ongoing requests
    if ('close' === packet.type) {
      self.onClose();
      return false;
    }

    // otherwise bypass onData and handle the message
    self.onPacket(packet);
  };

  // decode payload
  parser.decodePayload(data, this.socket.binaryType, callback);

  // if an event did not trigger closing
  if ('closed' !== this.readyState) {
    // if we got data we're not polling
    this.polling = false;
    this.emit('pollComplete');

    if ('open' === this.readyState) {
      this.poll();
    } else {
      debug('ignoring poll - transport state "%s"', this.readyState);
    }
  }
};

/**
 * For polling, send a close packet.
 *
 * @api private
 */

Polling.prototype.doClose = function () {
  var self = this;

  function close () {
    debug('writing close packet');
    self.write([{ type: 'close' }]);
  }

  if ('open' === this.readyState) {
    debug('transport open - closing');
    close();
  } else {
    // in case we're trying to close while
    // handshaking is in progress (GH-164)
    debug('transport not open - deferring close');
    this.once('open', close);
  }
};

/**
 * Writes a packets payload.
 *
 * @param {Array} data packets
 * @param {Function} drain callback
 * @api private
 */

Polling.prototype.write = function (packets) {
  var self = this;
  this.writable = false;
  var callbackfn = function () {
    self.writable = true;
    self.emit('drain');
  };

  parser.encodePayload(packets, this.supportsBinary, function (data) {
    self.doWrite(data, callbackfn);
  });
};

/**
 * Generates uri for connection.
 *
 * @api private
 */

Polling.prototype.uri = function () {
  var query = this.query || {};
  var schema = this.secure ? 'https' : 'http';
  var port = '';

  // cache busting is forced
  if (false !== this.timestampRequests) {
    query[this.timestampParam] = yeast();
  }

  if (!this.supportsBinary && !query.sid) {
    query.b64 = 1;
  }

  query = parseqs.encode(query);

  // avoid port if default for schema
  if (this.port && (('https' === schema && Number(this.port) !== 443) ||
     ('http' === schema && Number(this.port) !== 80))) {
    port = ':' + this.port;
  }

  // prepend ? to query
  if (query.length) {
    query = '?' + query;
  }

  var ipv6 = this.hostname.indexOf(':') !== -1;
  return schema + '://' + (ipv6 ? '[' + this.hostname + ']' : this.hostname) + port + this.path + query;
};

},{"../transport":68,"component-inherit":41,"debug":64,"engine.io-parser":43,"parseqs":54,"xmlhttprequest-ssl":74,"yeast":101}],73:[function(require,module,exports){
(function (Buffer){
/**
 * Module dependencies.
 */

var Transport = require('../transport');
var parser = require('engine.io-parser');
var parseqs = require('parseqs');
var inherit = require('component-inherit');
var yeast = require('yeast');
var debug = require('debug')('engine.io-client:websocket');
var BrowserWebSocket, NodeWebSocket;
if (typeof self === 'undefined') {
  try {
    NodeWebSocket = require('ws');
  } catch (e) { }
} else {
  BrowserWebSocket = self.WebSocket || self.MozWebSocket;
}

/**
 * Get either the `WebSocket` or `MozWebSocket` globals
 * in the browser or try to resolve WebSocket-compatible
 * interface exposed by `ws` for Node-like environment.
 */

var WebSocket = BrowserWebSocket || NodeWebSocket;

/**
 * Module exports.
 */

module.exports = WS;

/**
 * WebSocket transport constructor.
 *
 * @api {Object} connection options
 * @api public
 */

function WS (opts) {
  var forceBase64 = (opts && opts.forceBase64);
  if (forceBase64) {
    this.supportsBinary = false;
  }
  this.perMessageDeflate = opts.perMessageDeflate;
  this.usingBrowserWebSocket = BrowserWebSocket && !opts.forceNode;
  this.protocols = opts.protocols;
  if (!this.usingBrowserWebSocket) {
    WebSocket = NodeWebSocket;
  }
  Transport.call(this, opts);
}

/**
 * Inherits from Transport.
 */

inherit(WS, Transport);

/**
 * Transport name.
 *
 * @api public
 */

WS.prototype.name = 'websocket';

/*
 * WebSockets support binary
 */

WS.prototype.supportsBinary = true;

/**
 * Opens socket.
 *
 * @api private
 */

WS.prototype.doOpen = function () {
  if (!this.check()) {
    // let probe timeout
    return;
  }

  var uri = this.uri();
  var protocols = this.protocols;
  var opts = {
    agent: this.agent,
    perMessageDeflate: this.perMessageDeflate
  };

  // SSL options for Node.js client
  opts.pfx = this.pfx;
  opts.key = this.key;
  opts.passphrase = this.passphrase;
  opts.cert = this.cert;
  opts.ca = this.ca;
  opts.ciphers = this.ciphers;
  opts.rejectUnauthorized = this.rejectUnauthorized;
  if (this.extraHeaders) {
    opts.headers = this.extraHeaders;
  }
  if (this.localAddress) {
    opts.localAddress = this.localAddress;
  }

  try {
    this.ws = this.usingBrowserWebSocket && !this.isReactNative ? (protocols ? new WebSocket(uri, protocols) : new WebSocket(uri)) : new WebSocket(uri, protocols, opts);
  } catch (err) {
    return this.emit('error', err);
  }

  if (this.ws.binaryType === undefined) {
    this.supportsBinary = false;
  }

  if (this.ws.supports && this.ws.supports.binary) {
    this.supportsBinary = true;
    this.ws.binaryType = 'nodebuffer';
  } else {
    this.ws.binaryType = 'arraybuffer';
  }

  this.addEventListeners();
};

/**
 * Adds event listeners to the socket
 *
 * @api private
 */

WS.prototype.addEventListeners = function () {
  var self = this;

  this.ws.onopen = function () {
    self.onOpen();
  };
  this.ws.onclose = function () {
    self.onClose();
  };
  this.ws.onmessage = function (ev) {
    self.onData(ev.data);
  };
  this.ws.onerror = function (e) {
    self.onError('websocket error', e);
  };
};

/**
 * Writes data to socket.
 *
 * @param {Array} array of packets.
 * @api private
 */

WS.prototype.write = function (packets) {
  var self = this;
  this.writable = false;

  // encodePacket efficient as it uses WS framing
  // no need for encodePayload
  var total = packets.length;
  for (var i = 0, l = total; i < l; i++) {
    (function (packet) {
      parser.encodePacket(packet, self.supportsBinary, function (data) {
        if (!self.usingBrowserWebSocket) {
          // always create a new object (GH-437)
          var opts = {};
          if (packet.options) {
            opts.compress = packet.options.compress;
          }

          if (self.perMessageDeflate) {
            var len = 'string' === typeof data ? Buffer.byteLength(data) : data.length;
            if (len < self.perMessageDeflate.threshold) {
              opts.compress = false;
            }
          }
        }

        // Sometimes the websocket has already been closed but the browser didn't
        // have a chance of informing us about it yet, in that case send will
        // throw an error
        try {
          if (self.usingBrowserWebSocket) {
            // TypeError is thrown when passing the second argument on Safari
            self.ws.send(data);
          } else {
            self.ws.send(data, opts);
          }
        } catch (e) {
          debug('websocket closed before onclose event');
        }

        --total || done();
      });
    })(packets[i]);
  }

  function done () {
    self.emit('flush');

    // fake drain
    // defer to next tick to allow Socket to clear writeBuffer
    setTimeout(function () {
      self.writable = true;
      self.emit('drain');
    }, 0);
  }
};

/**
 * Called upon close
 *
 * @api private
 */

WS.prototype.onClose = function () {
  Transport.prototype.onClose.call(this);
};

/**
 * Closes socket.
 *
 * @api private
 */

WS.prototype.doClose = function () {
  if (typeof this.ws !== 'undefined') {
    this.ws.close();
  }
};

/**
 * Generates uri for connection.
 *
 * @api private
 */

WS.prototype.uri = function () {
  var query = this.query || {};
  var schema = this.secure ? 'wss' : 'ws';
  var port = '';

  // avoid port if default for schema
  if (this.port && (('wss' === schema && Number(this.port) !== 443) ||
    ('ws' === schema && Number(this.port) !== 80))) {
    port = ':' + this.port;
  }

  // append timestamp to URI
  if (this.timestampRequests) {
    query[this.timestampParam] = yeast();
  }

  // communicate binary support capabilities
  if (!this.supportsBinary) {
    query.b64 = 1;
  }

  query = parseqs.encode(query);

  // prepend ? to query
  if (query.length) {
    query = '?' + query;
  }

  var ipv6 = this.hostname.indexOf(':') !== -1;
  return schema + '://' + (ipv6 ? '[' + this.hostname + ']' : this.hostname) + port + this.path + query;
};

/**
 * Feature detection for WebSocket.
 *
 * @return {Boolean} whether this transport is available.
 * @api public
 */

WS.prototype.check = function () {
  return !!WebSocket && !('__initialize' in WebSocket && this.name === WS.prototype.name);
};

}).call(this,require("buffer").Buffer)
},{"../transport":68,"buffer":38,"component-inherit":41,"debug":64,"engine.io-parser":43,"parseqs":54,"ws":37,"yeast":101}],74:[function(require,module,exports){
// browser shim for xmlhttprequest module

var hasCORS = require('has-cors');

module.exports = function (opts) {
  var xdomain = opts.xdomain;

  // scheme must be same when usign XDomainRequest
  // http://blogs.msdn.com/b/ieinternals/archive/2010/05/13/xdomainrequest-restrictions-limitations-and-workarounds.aspx
  var xscheme = opts.xscheme;

  // XDomainRequest has a flow of not sending cookie, therefore it should be disabled as a default.
  // https://github.com/Automattic/engine.io-client/pull/217
  var enablesXDR = opts.enablesXDR;

  // XMLHttpRequest can be disabled on IE
  try {
    if ('undefined' !== typeof XMLHttpRequest && (!xdomain || hasCORS)) {
      return new XMLHttpRequest();
    }
  } catch (e) { }

  // Use XDomainRequest for IE8 if enablesXDR is true
  // because loading bar keeps flashing when using jsonp-polling
  // https://github.com/yujiosaka/socke.io-ie8-loading-example
  try {
    if ('undefined' !== typeof XDomainRequest && !xscheme && enablesXDR) {
      return new XDomainRequest();
    }
  } catch (e) { }

  if (!xdomain) {
    try {
      return new self[['Active'].concat('Object').join('X')]('Microsoft.XMLHTTP');
    } catch (e) { }
  }
};

},{"has-cors":48}],75:[function(require,module,exports){
arguments[4][47][0].apply(exports,arguments)
},{"dup":47}],76:[function(require,module,exports){
/*global Blob,File*/

/**
 * Module requirements
 */

var isArray = require('isarray');
var isBuf = require('./is-buffer');
var toString = Object.prototype.toString;
var withNativeBlob = typeof Blob === 'function' || (typeof Blob !== 'undefined' && toString.call(Blob) === '[object BlobConstructor]');
var withNativeFile = typeof File === 'function' || (typeof File !== 'undefined' && toString.call(File) === '[object FileConstructor]');

/**
 * Replaces every Buffer | ArrayBuffer in packet with a numbered placeholder.
 * Anything with blobs or files should be fed through removeBlobs before coming
 * here.
 *
 * @param {Object} packet - socket.io event packet
 * @return {Object} with deconstructed packet and list of buffers
 * @api public
 */

exports.deconstructPacket = function(packet) {
  var buffers = [];
  var packetData = packet.data;
  var pack = packet;
  pack.data = _deconstructPacket(packetData, buffers);
  pack.attachments = buffers.length; // number of binary 'attachments'
  return {packet: pack, buffers: buffers};
};

function _deconstructPacket(data, buffers) {
  if (!data) return data;

  if (isBuf(data)) {
    var placeholder = { _placeholder: true, num: buffers.length };
    buffers.push(data);
    return placeholder;
  } else if (isArray(data)) {
    var newData = new Array(data.length);
    for (var i = 0; i < data.length; i++) {
      newData[i] = _deconstructPacket(data[i], buffers);
    }
    return newData;
  } else if (typeof data === 'object' && !(data instanceof Date)) {
    var newData = {};
    for (var key in data) {
      newData[key] = _deconstructPacket(data[key], buffers);
    }
    return newData;
  }
  return data;
}

/**
 * Reconstructs a binary packet from its placeholder packet and buffers
 *
 * @param {Object} packet - event packet with placeholders
 * @param {Array} buffers - binary buffers to put in placeholder positions
 * @return {Object} reconstructed packet
 * @api public
 */

exports.reconstructPacket = function(packet, buffers) {
  packet.data = _reconstructPacket(packet.data, buffers);
  packet.attachments = undefined; // no longer useful
  return packet;
};

function _reconstructPacket(data, buffers) {
  if (!data) return data;

  if (data && data._placeholder) {
    return buffers[data.num]; // appropriate buffer (should be natural order anyway)
  } else if (isArray(data)) {
    for (var i = 0; i < data.length; i++) {
      data[i] = _reconstructPacket(data[i], buffers);
    }
  } else if (typeof data === 'object') {
    for (var key in data) {
      data[key] = _reconstructPacket(data[key], buffers);
    }
  }

  return data;
}

/**
 * Asynchronously removes Blobs or Files from data via
 * FileReader's readAsArrayBuffer method. Used before encoding
 * data as msgpack. Calls callback with the blobless data.
 *
 * @param {Object} data
 * @param {Function} callback
 * @api private
 */

exports.removeBlobs = function(data, callback) {
  function _removeBlobs(obj, curKey, containingObject) {
    if (!obj) return obj;

    // convert any blob
    if ((withNativeBlob && obj instanceof Blob) ||
        (withNativeFile && obj instanceof File)) {
      pendingBlobs++;

      // async filereader
      var fileReader = new FileReader();
      fileReader.onload = function() { // this.result == arraybuffer
        if (containingObject) {
          containingObject[curKey] = this.result;
        }
        else {
          bloblessData = this.result;
        }

        // if nothing pending its callback time
        if(! --pendingBlobs) {
          callback(bloblessData);
        }
      };

      fileReader.readAsArrayBuffer(obj); // blob -> arraybuffer
    } else if (isArray(obj)) { // handle array
      for (var i = 0; i < obj.length; i++) {
        _removeBlobs(obj[i], i, obj);
      }
    } else if (typeof obj === 'object' && !isBuf(obj)) { // and object
      for (var key in obj) {
        _removeBlobs(obj[key], key, obj);
      }
    }
  }

  var pendingBlobs = 0;
  var bloblessData = data;
  _removeBlobs(bloblessData);
  if (!pendingBlobs) {
    callback(bloblessData);
  }
};

},{"./is-buffer":78,"isarray":75}],77:[function(require,module,exports){

/**
 * Module dependencies.
 */

var debug = require('debug')('socket.io-parser');
var Emitter = require('component-emitter');
var binary = require('./binary');
var isArray = require('isarray');
var isBuf = require('./is-buffer');

/**
 * Protocol version.
 *
 * @api public
 */

exports.protocol = 4;

/**
 * Packet types.
 *
 * @api public
 */

exports.types = [
  'CONNECT',
  'DISCONNECT',
  'EVENT',
  'ACK',
  'ERROR',
  'BINARY_EVENT',
  'BINARY_ACK'
];

/**
 * Packet type `connect`.
 *
 * @api public
 */

exports.CONNECT = 0;

/**
 * Packet type `disconnect`.
 *
 * @api public
 */

exports.DISCONNECT = 1;

/**
 * Packet type `event`.
 *
 * @api public
 */

exports.EVENT = 2;

/**
 * Packet type `ack`.
 *
 * @api public
 */

exports.ACK = 3;

/**
 * Packet type `error`.
 *
 * @api public
 */

exports.ERROR = 4;

/**
 * Packet type 'binary event'
 *
 * @api public
 */

exports.BINARY_EVENT = 5;

/**
 * Packet type `binary ack`. For acks with binary arguments.
 *
 * @api public
 */

exports.BINARY_ACK = 6;

/**
 * Encoder constructor.
 *
 * @api public
 */

exports.Encoder = Encoder;

/**
 * Decoder constructor.
 *
 * @api public
 */

exports.Decoder = Decoder;

/**
 * A socket.io Encoder instance
 *
 * @api public
 */

function Encoder() {}

var ERROR_PACKET = exports.ERROR + '"encode error"';

/**
 * Encode a packet as a single string if non-binary, or as a
 * buffer sequence, depending on packet type.
 *
 * @param {Object} obj - packet object
 * @param {Function} callback - function to handle encodings (likely engine.write)
 * @return Calls callback with Array of encodings
 * @api public
 */

Encoder.prototype.encode = function(obj, callback){
  debug('encoding packet %j', obj);

  if (exports.BINARY_EVENT === obj.type || exports.BINARY_ACK === obj.type) {
    encodeAsBinary(obj, callback);
  } else {
    var encoding = encodeAsString(obj);
    callback([encoding]);
  }
};

/**
 * Encode packet as string.
 *
 * @param {Object} packet
 * @return {String} encoded
 * @api private
 */

function encodeAsString(obj) {

  // first is type
  var str = '' + obj.type;

  // attachments if we have them
  if (exports.BINARY_EVENT === obj.type || exports.BINARY_ACK === obj.type) {
    str += obj.attachments + '-';
  }

  // if we have a namespace other than `/`
  // we append it followed by a comma `,`
  if (obj.nsp && '/' !== obj.nsp) {
    str += obj.nsp + ',';
  }

  // immediately followed by the id
  if (null != obj.id) {
    str += obj.id;
  }

  // json data
  if (null != obj.data) {
    var payload = tryStringify(obj.data);
    if (payload !== false) {
      str += payload;
    } else {
      return ERROR_PACKET;
    }
  }

  debug('encoded %j as %s', obj, str);
  return str;
}

function tryStringify(str) {
  try {
    return JSON.stringify(str);
  } catch(e){
    return false;
  }
}

/**
 * Encode packet as 'buffer sequence' by removing blobs, and
 * deconstructing packet into object with placeholders and
 * a list of buffers.
 *
 * @param {Object} packet
 * @return {Buffer} encoded
 * @api private
 */

function encodeAsBinary(obj, callback) {

  function writeEncoding(bloblessData) {
    var deconstruction = binary.deconstructPacket(bloblessData);
    var pack = encodeAsString(deconstruction.packet);
    var buffers = deconstruction.buffers;

    buffers.unshift(pack); // add packet info to beginning of data list
    callback(buffers); // write all the buffers
  }

  binary.removeBlobs(obj, writeEncoding);
}

/**
 * A socket.io Decoder instance
 *
 * @return {Object} decoder
 * @api public
 */

function Decoder() {
  this.reconstructor = null;
}

/**
 * Mix in `Emitter` with Decoder.
 */

Emitter(Decoder.prototype);

/**
 * Decodes an encoded packet string into packet JSON.
 *
 * @param {String} obj - encoded packet
 * @return {Object} packet
 * @api public
 */

Decoder.prototype.add = function(obj) {
  var packet;
  if (typeof obj === 'string') {
    packet = decodeString(obj);
    if (exports.BINARY_EVENT === packet.type || exports.BINARY_ACK === packet.type) { // binary packet's json
      this.reconstructor = new BinaryReconstructor(packet);

      // no attachments, labeled binary but no binary data to follow
      if (this.reconstructor.reconPack.attachments === 0) {
        this.emit('decoded', packet);
      }
    } else { // non-binary full packet
      this.emit('decoded', packet);
    }
  } else if (isBuf(obj) || obj.base64) { // raw binary data
    if (!this.reconstructor) {
      throw new Error('got binary data when not reconstructing a packet');
    } else {
      packet = this.reconstructor.takeBinaryData(obj);
      if (packet) { // received final buffer
        this.reconstructor = null;
        this.emit('decoded', packet);
      }
    }
  } else {
    throw new Error('Unknown type: ' + obj);
  }
};

/**
 * Decode a packet String (JSON data)
 *
 * @param {String} str
 * @return {Object} packet
 * @api private
 */

function decodeString(str) {
  var i = 0;
  // look up type
  var p = {
    type: Number(str.charAt(0))
  };

  if (null == exports.types[p.type]) {
    return error('unknown packet type ' + p.type);
  }

  // look up attachments if type binary
  if (exports.BINARY_EVENT === p.type || exports.BINARY_ACK === p.type) {
    var buf = '';
    while (str.charAt(++i) !== '-') {
      buf += str.charAt(i);
      if (i == str.length) break;
    }
    if (buf != Number(buf) || str.charAt(i) !== '-') {
      throw new Error('Illegal attachments');
    }
    p.attachments = Number(buf);
  }

  // look up namespace (if any)
  if ('/' === str.charAt(i + 1)) {
    p.nsp = '';
    while (++i) {
      var c = str.charAt(i);
      if (',' === c) break;
      p.nsp += c;
      if (i === str.length) break;
    }
  } else {
    p.nsp = '/';
  }

  // look up id
  var next = str.charAt(i + 1);
  if ('' !== next && Number(next) == next) {
    p.id = '';
    while (++i) {
      var c = str.charAt(i);
      if (null == c || Number(c) != c) {
        --i;
        break;
      }
      p.id += str.charAt(i);
      if (i === str.length) break;
    }
    p.id = Number(p.id);
  }

  // look up json data
  if (str.charAt(++i)) {
    var payload = tryParse(str.substr(i));
    var isPayloadValid = payload !== false && (p.type === exports.ERROR || isArray(payload));
    if (isPayloadValid) {
      p.data = payload;
    } else {
      return error('invalid payload');
    }
  }

  debug('decoded %s as %j', str, p);
  return p;
}

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch(e){
    return false;
  }
}

/**
 * Deallocates a parser's resources
 *
 * @api public
 */

Decoder.prototype.destroy = function() {
  if (this.reconstructor) {
    this.reconstructor.finishedReconstruction();
  }
};

/**
 * A manager of a binary event's 'buffer sequence'. Should
 * be constructed whenever a packet of type BINARY_EVENT is
 * decoded.
 *
 * @param {Object} packet
 * @return {BinaryReconstructor} initialized reconstructor
 * @api private
 */

function BinaryReconstructor(packet) {
  this.reconPack = packet;
  this.buffers = [];
}

/**
 * Method to be called when binary data received from connection
 * after a BINARY_EVENT packet.
 *
 * @param {Buffer | ArrayBuffer} binData - the raw binary data received
 * @return {null | Object} returns null if more binary data is expected or
 *   a reconstructed packet object if all buffers have been received.
 * @api private
 */

BinaryReconstructor.prototype.takeBinaryData = function(binData) {
  this.buffers.push(binData);
  if (this.buffers.length === this.reconPack.attachments) { // done with buffer list
    var packet = binary.reconstructPacket(this.reconPack, this.buffers);
    this.finishedReconstruction();
    return packet;
  }
  return null;
};

/**
 * Cleans up binary packet reconstruction variables.
 *
 * @api private
 */

BinaryReconstructor.prototype.finishedReconstruction = function() {
  this.reconPack = null;
  this.buffers = [];
};

function error(msg) {
  return {
    type: exports.ERROR,
    data: 'parser error: ' + msg
  };
}

},{"./binary":76,"./is-buffer":78,"component-emitter":40,"debug":64,"isarray":75}],78:[function(require,module,exports){
(function (Buffer){

module.exports = isBuf;

var withNativeBuffer = typeof Buffer === 'function' && typeof Buffer.isBuffer === 'function';
var withNativeArrayBuffer = typeof ArrayBuffer === 'function';

var isView = function (obj) {
  return typeof ArrayBuffer.isView === 'function' ? ArrayBuffer.isView(obj) : (obj.buffer instanceof ArrayBuffer);
};

/**
 * Returns true if obj is a buffer or an arraybuffer.
 *
 * @api private
 */

function isBuf(obj) {
  return (withNativeBuffer && Buffer.isBuffer(obj)) ||
          (withNativeArrayBuffer && (obj instanceof ArrayBuffer || isView(obj)));
}

}).call(this,require("buffer").Buffer)
},{"buffer":38}],79:[function(require,module,exports){
module.exports = toArray

function toArray(list, index) {
    var array = []

    index = index || 0

    for (var i = index || 0; i < list.length; i++) {
        array[i - index] = list[i]
    }

    return array
}

},{}],80:[function(require,module,exports){
var v1 = require('./v1');
var v4 = require('./v4');

var uuid = v4;
uuid.v1 = v1;
uuid.v4 = v4;

module.exports = uuid;

},{"./v1":83,"./v4":84}],81:[function(require,module,exports){
/**
 * Convert array of 16 byte values to UUID string format of the form:
 * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
 */
var byteToHex = [];
for (var i = 0; i < 256; ++i) {
  byteToHex[i] = (i + 0x100).toString(16).substr(1);
}

function bytesToUuid(buf, offset) {
  var i = offset || 0;
  var bth = byteToHex;
  // join used to fix memory issue caused by concatenation: https://bugs.chromium.org/p/v8/issues/detail?id=3175#c4
  return ([bth[buf[i++]], bth[buf[i++]], 
	bth[buf[i++]], bth[buf[i++]], '-',
	bth[buf[i++]], bth[buf[i++]], '-',
	bth[buf[i++]], bth[buf[i++]], '-',
	bth[buf[i++]], bth[buf[i++]], '-',
	bth[buf[i++]], bth[buf[i++]],
	bth[buf[i++]], bth[buf[i++]],
	bth[buf[i++]], bth[buf[i++]]]).join('');
}

module.exports = bytesToUuid;

},{}],82:[function(require,module,exports){
// Unique ID creation requires a high quality random # generator.  In the
// browser this is a little complicated due to unknown quality of Math.random()
// and inconsistent support for the `crypto` API.  We do the best we can via
// feature-detection

// getRandomValues needs to be invoked in a context where "this" is a Crypto
// implementation. Also, find the complete implementation of crypto on IE11.
var getRandomValues = (typeof(crypto) != 'undefined' && crypto.getRandomValues && crypto.getRandomValues.bind(crypto)) ||
                      (typeof(msCrypto) != 'undefined' && typeof window.msCrypto.getRandomValues == 'function' && msCrypto.getRandomValues.bind(msCrypto));

if (getRandomValues) {
  // WHATWG crypto RNG - http://wiki.whatwg.org/wiki/Crypto
  var rnds8 = new Uint8Array(16); // eslint-disable-line no-undef

  module.exports = function whatwgRNG() {
    getRandomValues(rnds8);
    return rnds8;
  };
} else {
  // Math.random()-based (RNG)
  //
  // If all else fails, use Math.random().  It's fast, but is of unspecified
  // quality.
  var rnds = new Array(16);

  module.exports = function mathRNG() {
    for (var i = 0, r; i < 16; i++) {
      if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
      rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return rnds;
  };
}

},{}],83:[function(require,module,exports){
var rng = require('./lib/rng');
var bytesToUuid = require('./lib/bytesToUuid');

// **`v1()` - Generate time-based UUID**
//
// Inspired by https://github.com/LiosK/UUID.js
// and http://docs.python.org/library/uuid.html

var _nodeId;
var _clockseq;

// Previous uuid creation time
var _lastMSecs = 0;
var _lastNSecs = 0;

// See https://github.com/broofa/node-uuid for API details
function v1(options, buf, offset) {
  var i = buf && offset || 0;
  var b = buf || [];

  options = options || {};
  var node = options.node || _nodeId;
  var clockseq = options.clockseq !== undefined ? options.clockseq : _clockseq;

  // node and clockseq need to be initialized to random values if they're not
  // specified.  We do this lazily to minimize issues related to insufficient
  // system entropy.  See #189
  if (node == null || clockseq == null) {
    var seedBytes = rng();
    if (node == null) {
      // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
      node = _nodeId = [
        seedBytes[0] | 0x01,
        seedBytes[1], seedBytes[2], seedBytes[3], seedBytes[4], seedBytes[5]
      ];
    }
    if (clockseq == null) {
      // Per 4.2.2, randomize (14 bit) clockseq
      clockseq = _clockseq = (seedBytes[6] << 8 | seedBytes[7]) & 0x3fff;
    }
  }

  // UUID timestamps are 100 nano-second units since the Gregorian epoch,
  // (1582-10-15 00:00).  JSNumbers aren't precise enough for this, so
  // time is handled internally as 'msecs' (integer milliseconds) and 'nsecs'
  // (100-nanoseconds offset from msecs) since unix epoch, 1970-01-01 00:00.
  var msecs = options.msecs !== undefined ? options.msecs : new Date().getTime();

  // Per 4.2.1.2, use count of uuid's generated during the current clock
  // cycle to simulate higher resolution clock
  var nsecs = options.nsecs !== undefined ? options.nsecs : _lastNSecs + 1;

  // Time since last uuid creation (in msecs)
  var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs)/10000;

  // Per 4.2.1.2, Bump clockseq on clock regression
  if (dt < 0 && options.clockseq === undefined) {
    clockseq = clockseq + 1 & 0x3fff;
  }

  // Reset nsecs if clock regresses (new clockseq) or we've moved onto a new
  // time interval
  if ((dt < 0 || msecs > _lastMSecs) && options.nsecs === undefined) {
    nsecs = 0;
  }

  // Per 4.2.1.2 Throw error if too many uuids are requested
  if (nsecs >= 10000) {
    throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
  }

  _lastMSecs = msecs;
  _lastNSecs = nsecs;
  _clockseq = clockseq;

  // Per 4.1.4 - Convert from unix epoch to Gregorian epoch
  msecs += 12219292800000;

  // `time_low`
  var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
  b[i++] = tl >>> 24 & 0xff;
  b[i++] = tl >>> 16 & 0xff;
  b[i++] = tl >>> 8 & 0xff;
  b[i++] = tl & 0xff;

  // `time_mid`
  var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
  b[i++] = tmh >>> 8 & 0xff;
  b[i++] = tmh & 0xff;

  // `time_high_and_version`
  b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
  b[i++] = tmh >>> 16 & 0xff;

  // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
  b[i++] = clockseq >>> 8 | 0x80;

  // `clock_seq_low`
  b[i++] = clockseq & 0xff;

  // `node`
  for (var n = 0; n < 6; ++n) {
    b[i + n] = node[n];
  }

  return buf ? buf : bytesToUuid(b);
}

module.exports = v1;

},{"./lib/bytesToUuid":81,"./lib/rng":82}],84:[function(require,module,exports){
var rng = require('./lib/rng');
var bytesToUuid = require('./lib/bytesToUuid');

function v4(options, buf, offset) {
  var i = buf && offset || 0;

  if (typeof(options) == 'string') {
    buf = options === 'binary' ? new Array(16) : null;
    options = null;
  }
  options = options || {};

  var rnds = options.random || (options.rng || rng)();

  // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
  rnds[6] = (rnds[6] & 0x0f) | 0x40;
  rnds[8] = (rnds[8] & 0x3f) | 0x80;

  // Copy bytes to buffer, if provided
  if (buf) {
    for (var ii = 0; ii < 16; ++ii) {
      buf[i + ii] = rnds[ii];
    }
  }

  return buf || bytesToUuid(rnds);
}

module.exports = v4;

},{"./lib/bytesToUuid":81,"./lib/rng":82}],85:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */

'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _adapter_factory = require('./adapter_factory.js');

var adapter = (0, _adapter_factory.adapterFactory)({ window: window });
exports.default = adapter;

},{"./adapter_factory.js":86}],86:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.adapterFactory = adapterFactory;

var _utils = require('./utils');

var utils = _interopRequireWildcard(_utils);

var _chrome_shim = require('./chrome/chrome_shim');

var chromeShim = _interopRequireWildcard(_chrome_shim);

var _edge_shim = require('./edge/edge_shim');

var edgeShim = _interopRequireWildcard(_edge_shim);

var _firefox_shim = require('./firefox/firefox_shim');

var firefoxShim = _interopRequireWildcard(_firefox_shim);

var _safari_shim = require('./safari/safari_shim');

var safariShim = _interopRequireWildcard(_safari_shim);

var _common_shim = require('./common_shim');

var commonShim = _interopRequireWildcard(_common_shim);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

// Shimming starts here.
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
function adapterFactory() {
  var _ref = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
      window = _ref.window;

  var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {
    shimChrome: true,
    shimFirefox: true,
    shimEdge: true,
    shimSafari: true
  };

  // Utils.
  var logging = utils.log;
  var browserDetails = utils.detectBrowser(window);

  var adapter = {
    browserDetails: browserDetails,
    commonShim: commonShim,
    extractVersion: utils.extractVersion,
    disableLog: utils.disableLog,
    disableWarnings: utils.disableWarnings
  };

  // Shim browser if found.
  switch (browserDetails.browser) {
    case 'chrome':
      if (!chromeShim || !chromeShim.shimPeerConnection || !options.shimChrome) {
        logging('Chrome shim is not included in this adapter release.');
        return adapter;
      }
      logging('adapter.js shimming chrome.');
      // Export to the adapter global object visible in the browser.
      adapter.browserShim = chromeShim;

      chromeShim.shimGetUserMedia(window);
      chromeShim.shimMediaStream(window);
      chromeShim.shimPeerConnection(window);
      chromeShim.shimOnTrack(window);
      chromeShim.shimAddTrackRemoveTrack(window);
      chromeShim.shimGetSendersWithDtmf(window);
      chromeShim.shimGetStats(window);
      chromeShim.shimSenderReceiverGetStats(window);
      chromeShim.fixNegotiationNeeded(window);

      commonShim.shimRTCIceCandidate(window);
      commonShim.shimConnectionState(window);
      commonShim.shimMaxMessageSize(window);
      commonShim.shimSendThrowTypeError(window);
      commonShim.removeAllowExtmapMixed(window);
      break;
    case 'firefox':
      if (!firefoxShim || !firefoxShim.shimPeerConnection || !options.shimFirefox) {
        logging('Firefox shim is not included in this adapter release.');
        return adapter;
      }
      logging('adapter.js shimming firefox.');
      // Export to the adapter global object visible in the browser.
      adapter.browserShim = firefoxShim;

      firefoxShim.shimGetUserMedia(window);
      firefoxShim.shimPeerConnection(window);
      firefoxShim.shimOnTrack(window);
      firefoxShim.shimRemoveStream(window);
      firefoxShim.shimSenderGetStats(window);
      firefoxShim.shimReceiverGetStats(window);
      firefoxShim.shimRTCDataChannel(window);
      firefoxShim.shimAddTransceiver(window);
      firefoxShim.shimCreateOffer(window);
      firefoxShim.shimCreateAnswer(window);

      commonShim.shimRTCIceCandidate(window);
      commonShim.shimConnectionState(window);
      commonShim.shimMaxMessageSize(window);
      commonShim.shimSendThrowTypeError(window);
      break;
    case 'edge':
      if (!edgeShim || !edgeShim.shimPeerConnection || !options.shimEdge) {
        logging('MS edge shim is not included in this adapter release.');
        return adapter;
      }
      logging('adapter.js shimming edge.');
      // Export to the adapter global object visible in the browser.
      adapter.browserShim = edgeShim;

      edgeShim.shimGetUserMedia(window);
      edgeShim.shimGetDisplayMedia(window);
      edgeShim.shimPeerConnection(window);
      edgeShim.shimReplaceTrack(window);

      // the edge shim implements the full RTCIceCandidate object.

      commonShim.shimMaxMessageSize(window);
      commonShim.shimSendThrowTypeError(window);
      break;
    case 'safari':
      if (!safariShim || !options.shimSafari) {
        logging('Safari shim is not included in this adapter release.');
        return adapter;
      }
      logging('adapter.js shimming safari.');
      // Export to the adapter global object visible in the browser.
      adapter.browserShim = safariShim;

      safariShim.shimRTCIceServerUrls(window);
      safariShim.shimCreateOfferLegacy(window);
      safariShim.shimCallbacksAPI(window);
      safariShim.shimLocalStreamsAPI(window);
      safariShim.shimRemoteStreamsAPI(window);
      safariShim.shimTrackEventTransceiver(window);
      safariShim.shimGetUserMedia(window);

      commonShim.shimRTCIceCandidate(window);
      commonShim.shimMaxMessageSize(window);
      commonShim.shimSendThrowTypeError(window);
      commonShim.removeAllowExtmapMixed(window);
      break;
    default:
      logging('Unsupported browser!');
      break;
  }

  return adapter;
}

// Browser shims.

},{"./chrome/chrome_shim":87,"./common_shim":90,"./edge/edge_shim":91,"./firefox/firefox_shim":95,"./safari/safari_shim":98,"./utils":99}],87:[function(require,module,exports){

/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = exports.shimGetUserMedia = undefined;

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _getusermedia = require('./getusermedia');

Object.defineProperty(exports, 'shimGetUserMedia', {
  enumerable: true,
  get: function get() {
    return _getusermedia.shimGetUserMedia;
  }
});

var _getdisplaymedia = require('./getdisplaymedia');

Object.defineProperty(exports, 'shimGetDisplayMedia', {
  enumerable: true,
  get: function get() {
    return _getdisplaymedia.shimGetDisplayMedia;
  }
});
exports.shimMediaStream = shimMediaStream;
exports.shimOnTrack = shimOnTrack;
exports.shimGetSendersWithDtmf = shimGetSendersWithDtmf;
exports.shimGetStats = shimGetStats;
exports.shimSenderReceiverGetStats = shimSenderReceiverGetStats;
exports.shimAddTrackRemoveTrackWithNative = shimAddTrackRemoveTrackWithNative;
exports.shimAddTrackRemoveTrack = shimAddTrackRemoveTrack;
exports.shimPeerConnection = shimPeerConnection;
exports.fixNegotiationNeeded = fixNegotiationNeeded;

var _utils = require('../utils.js');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function shimMediaStream(window) {
  window.MediaStream = window.MediaStream || window.webkitMediaStream;
}

function shimOnTrack(window) {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && !('ontrack' in window.RTCPeerConnection.prototype)) {
    Object.defineProperty(window.RTCPeerConnection.prototype, 'ontrack', {
      get: function get() {
        return this._ontrack;
      },
      set: function set(f) {
        if (this._ontrack) {
          this.removeEventListener('track', this._ontrack);
        }
        this.addEventListener('track', this._ontrack = f);
      },

      enumerable: true,
      configurable: true
    });
    var origSetRemoteDescription = window.RTCPeerConnection.prototype.setRemoteDescription;
    window.RTCPeerConnection.prototype.setRemoteDescription = function setRemoteDescription() {
      var _this = this;

      if (!this._ontrackpoly) {
        this._ontrackpoly = function (e) {
          // onaddstream does not fire when a track is added to an existing
          // stream. But stream.onaddtrack is implemented so we use that.
          e.stream.addEventListener('addtrack', function (te) {
            var receiver = void 0;
            if (window.RTCPeerConnection.prototype.getReceivers) {
              receiver = _this.getReceivers().find(function (r) {
                return r.track && r.track.id === te.track.id;
              });
            } else {
              receiver = { track: te.track };
            }

            var event = new Event('track');
            event.track = te.track;
            event.receiver = receiver;
            event.transceiver = { receiver: receiver };
            event.streams = [e.stream];
            _this.dispatchEvent(event);
          });
          e.stream.getTracks().forEach(function (track) {
            var receiver = void 0;
            if (window.RTCPeerConnection.prototype.getReceivers) {
              receiver = _this.getReceivers().find(function (r) {
                return r.track && r.track.id === track.id;
              });
            } else {
              receiver = { track: track };
            }
            var event = new Event('track');
            event.track = track;
            event.receiver = receiver;
            event.transceiver = { receiver: receiver };
            event.streams = [e.stream];
            _this.dispatchEvent(event);
          });
        };
        this.addEventListener('addstream', this._ontrackpoly);
      }
      return origSetRemoteDescription.apply(this, arguments);
    };
  } else {
    // even if RTCRtpTransceiver is in window, it is only used and
    // emitted in unified-plan. Unfortunately this means we need
    // to unconditionally wrap the event.
    utils.wrapPeerConnectionEvent(window, 'track', function (e) {
      if (!e.transceiver) {
        Object.defineProperty(e, 'transceiver', { value: { receiver: e.receiver } });
      }
      return e;
    });
  }
}

function shimGetSendersWithDtmf(window) {
  // Overrides addTrack/removeTrack, depends on shimAddTrackRemoveTrack.
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && !('getSenders' in window.RTCPeerConnection.prototype) && 'createDTMFSender' in window.RTCPeerConnection.prototype) {
    var shimSenderWithDtmf = function shimSenderWithDtmf(pc, track) {
      return {
        track: track,
        get dtmf() {
          if (this._dtmf === undefined) {
            if (track.kind === 'audio') {
              this._dtmf = pc.createDTMFSender(track);
            } else {
              this._dtmf = null;
            }
          }
          return this._dtmf;
        },
        _pc: pc
      };
    };

    // augment addTrack when getSenders is not available.
    if (!window.RTCPeerConnection.prototype.getSenders) {
      window.RTCPeerConnection.prototype.getSenders = function getSenders() {
        this._senders = this._senders || [];
        return this._senders.slice(); // return a copy of the internal state.
      };
      var origAddTrack = window.RTCPeerConnection.prototype.addTrack;
      window.RTCPeerConnection.prototype.addTrack = function addTrack(track, stream) {
        var sender = origAddTrack.apply(this, arguments);
        if (!sender) {
          sender = shimSenderWithDtmf(this, track);
          this._senders.push(sender);
        }
        return sender;
      };

      var origRemoveTrack = window.RTCPeerConnection.prototype.removeTrack;
      window.RTCPeerConnection.prototype.removeTrack = function removeTrack(sender) {
        origRemoveTrack.apply(this, arguments);
        var idx = this._senders.indexOf(sender);
        if (idx !== -1) {
          this._senders.splice(idx, 1);
        }
      };
    }
    var origAddStream = window.RTCPeerConnection.prototype.addStream;
    window.RTCPeerConnection.prototype.addStream = function addStream(stream) {
      var _this2 = this;

      this._senders = this._senders || [];
      origAddStream.apply(this, [stream]);
      stream.getTracks().forEach(function (track) {
        _this2._senders.push(shimSenderWithDtmf(_this2, track));
      });
    };

    var origRemoveStream = window.RTCPeerConnection.prototype.removeStream;
    window.RTCPeerConnection.prototype.removeStream = function removeStream(stream) {
      var _this3 = this;

      this._senders = this._senders || [];
      origRemoveStream.apply(this, [stream]);

      stream.getTracks().forEach(function (track) {
        var sender = _this3._senders.find(function (s) {
          return s.track === track;
        });
        if (sender) {
          // remove sender
          _this3._senders.splice(_this3._senders.indexOf(sender), 1);
        }
      });
    };
  } else if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && 'getSenders' in window.RTCPeerConnection.prototype && 'createDTMFSender' in window.RTCPeerConnection.prototype && window.RTCRtpSender && !('dtmf' in window.RTCRtpSender.prototype)) {
    var origGetSenders = window.RTCPeerConnection.prototype.getSenders;
    window.RTCPeerConnection.prototype.getSenders = function getSenders() {
      var _this4 = this;

      var senders = origGetSenders.apply(this, []);
      senders.forEach(function (sender) {
        return sender._pc = _this4;
      });
      return senders;
    };

    Object.defineProperty(window.RTCRtpSender.prototype, 'dtmf', {
      get: function get() {
        if (this._dtmf === undefined) {
          if (this.track.kind === 'audio') {
            this._dtmf = this._pc.createDTMFSender(this.track);
          } else {
            this._dtmf = null;
          }
        }
        return this._dtmf;
      }
    });
  }
}

function shimGetStats(window) {
  if (!window.RTCPeerConnection) {
    return;
  }

  var origGetStats = window.RTCPeerConnection.prototype.getStats;
  window.RTCPeerConnection.prototype.getStats = function getStats() {
    var _this5 = this;

    var _arguments = Array.prototype.slice.call(arguments),
        selector = _arguments[0],
        onSucc = _arguments[1],
        onErr = _arguments[2];

    // If selector is a function then we are in the old style stats so just
    // pass back the original getStats format to avoid breaking old users.


    if (arguments.length > 0 && typeof selector === 'function') {
      return origGetStats.apply(this, arguments);
    }

    // When spec-style getStats is supported, return those when called with
    // either no arguments or the selector argument is null.
    if (origGetStats.length === 0 && (arguments.length === 0 || typeof selector !== 'function')) {
      return origGetStats.apply(this, []);
    }

    var fixChromeStats_ = function fixChromeStats_(response) {
      var standardReport = {};
      var reports = response.result();
      reports.forEach(function (report) {
        var standardStats = {
          id: report.id,
          timestamp: report.timestamp,
          type: {
            localcandidate: 'local-candidate',
            remotecandidate: 'remote-candidate'
          }[report.type] || report.type
        };
        report.names().forEach(function (name) {
          standardStats[name] = report.stat(name);
        });
        standardReport[standardStats.id] = standardStats;
      });

      return standardReport;
    };

    // shim getStats with maplike support
    var makeMapStats = function makeMapStats(stats) {
      return new Map(Object.keys(stats).map(function (key) {
        return [key, stats[key]];
      }));
    };

    if (arguments.length >= 2) {
      var successCallbackWrapper_ = function successCallbackWrapper_(response) {
        onSucc(makeMapStats(fixChromeStats_(response)));
      };

      return origGetStats.apply(this, [successCallbackWrapper_, selector]);
    }

    // promise-support
    return new Promise(function (resolve, reject) {
      origGetStats.apply(_this5, [function (response) {
        resolve(makeMapStats(fixChromeStats_(response)));
      }, reject]);
    }).then(onSucc, onErr);
  };
}

function shimSenderReceiverGetStats(window) {
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && window.RTCRtpSender && window.RTCRtpReceiver)) {
    return;
  }

  // shim sender stats.
  if (!('getStats' in window.RTCRtpSender.prototype)) {
    var origGetSenders = window.RTCPeerConnection.prototype.getSenders;
    if (origGetSenders) {
      window.RTCPeerConnection.prototype.getSenders = function getSenders() {
        var _this6 = this;

        var senders = origGetSenders.apply(this, []);
        senders.forEach(function (sender) {
          return sender._pc = _this6;
        });
        return senders;
      };
    }

    var origAddTrack = window.RTCPeerConnection.prototype.addTrack;
    if (origAddTrack) {
      window.RTCPeerConnection.prototype.addTrack = function addTrack() {
        var sender = origAddTrack.apply(this, arguments);
        sender._pc = this;
        return sender;
      };
    }
    window.RTCRtpSender.prototype.getStats = function getStats() {
      var sender = this;
      return this._pc.getStats().then(function (result) {
        return (
          /* Note: this will include stats of all senders that
           *   send a track with the same id as sender.track as
           *   it is not possible to identify the RTCRtpSender.
           */
          utils.filterStats(result, sender.track, true)
        );
      });
    };
  }

  // shim receiver stats.
  if (!('getStats' in window.RTCRtpReceiver.prototype)) {
    var origGetReceivers = window.RTCPeerConnection.prototype.getReceivers;
    if (origGetReceivers) {
      window.RTCPeerConnection.prototype.getReceivers = function getReceivers() {
        var _this7 = this;

        var receivers = origGetReceivers.apply(this, []);
        receivers.forEach(function (receiver) {
          return receiver._pc = _this7;
        });
        return receivers;
      };
    }
    utils.wrapPeerConnectionEvent(window, 'track', function (e) {
      e.receiver._pc = e.srcElement;
      return e;
    });
    window.RTCRtpReceiver.prototype.getStats = function getStats() {
      var receiver = this;
      return this._pc.getStats().then(function (result) {
        return utils.filterStats(result, receiver.track, false);
      });
    };
  }

  if (!('getStats' in window.RTCRtpSender.prototype && 'getStats' in window.RTCRtpReceiver.prototype)) {
    return;
  }

  // shim RTCPeerConnection.getStats(track).
  var origGetStats = window.RTCPeerConnection.prototype.getStats;
  window.RTCPeerConnection.prototype.getStats = function getStats() {
    if (arguments.length > 0 && arguments[0] instanceof window.MediaStreamTrack) {
      var track = arguments[0];
      var sender = void 0;
      var receiver = void 0;
      var err = void 0;
      this.getSenders().forEach(function (s) {
        if (s.track === track) {
          if (sender) {
            err = true;
          } else {
            sender = s;
          }
        }
      });
      this.getReceivers().forEach(function (r) {
        if (r.track === track) {
          if (receiver) {
            err = true;
          } else {
            receiver = r;
          }
        }
        return r.track === track;
      });
      if (err || sender && receiver) {
        return Promise.reject(new DOMException('There are more than one sender or receiver for the track.', 'InvalidAccessError'));
      } else if (sender) {
        return sender.getStats();
      } else if (receiver) {
        return receiver.getStats();
      }
      return Promise.reject(new DOMException('There is no sender or receiver for the track.', 'InvalidAccessError'));
    }
    return origGetStats.apply(this, arguments);
  };
}

function shimAddTrackRemoveTrackWithNative(window) {
  // shim addTrack/removeTrack with native variants in order to make
  // the interactions with legacy getLocalStreams behave as in other browsers.
  // Keeps a mapping stream.id => [stream, rtpsenders...]
  window.RTCPeerConnection.prototype.getLocalStreams = function getLocalStreams() {
    var _this8 = this;

    this._shimmedLocalStreams = this._shimmedLocalStreams || {};
    return Object.keys(this._shimmedLocalStreams).map(function (streamId) {
      return _this8._shimmedLocalStreams[streamId][0];
    });
  };

  var origAddTrack = window.RTCPeerConnection.prototype.addTrack;
  window.RTCPeerConnection.prototype.addTrack = function addTrack(track, stream) {
    if (!stream) {
      return origAddTrack.apply(this, arguments);
    }
    this._shimmedLocalStreams = this._shimmedLocalStreams || {};

    var sender = origAddTrack.apply(this, arguments);
    if (!this._shimmedLocalStreams[stream.id]) {
      this._shimmedLocalStreams[stream.id] = [stream, sender];
    } else if (this._shimmedLocalStreams[stream.id].indexOf(sender) === -1) {
      this._shimmedLocalStreams[stream.id].push(sender);
    }
    return sender;
  };

  var origAddStream = window.RTCPeerConnection.prototype.addStream;
  window.RTCPeerConnection.prototype.addStream = function addStream(stream) {
    var _this9 = this;

    this._shimmedLocalStreams = this._shimmedLocalStreams || {};

    stream.getTracks().forEach(function (track) {
      var alreadyExists = _this9.getSenders().find(function (s) {
        return s.track === track;
      });
      if (alreadyExists) {
        throw new DOMException('Track already exists.', 'InvalidAccessError');
      }
    });
    var existingSenders = this.getSenders();
    origAddStream.apply(this, arguments);
    var newSenders = this.getSenders().filter(function (newSender) {
      return existingSenders.indexOf(newSender) === -1;
    });
    this._shimmedLocalStreams[stream.id] = [stream].concat(newSenders);
  };

  var origRemoveStream = window.RTCPeerConnection.prototype.removeStream;
  window.RTCPeerConnection.prototype.removeStream = function removeStream(stream) {
    this._shimmedLocalStreams = this._shimmedLocalStreams || {};
    delete this._shimmedLocalStreams[stream.id];
    return origRemoveStream.apply(this, arguments);
  };

  var origRemoveTrack = window.RTCPeerConnection.prototype.removeTrack;
  window.RTCPeerConnection.prototype.removeTrack = function removeTrack(sender) {
    var _this10 = this;

    this._shimmedLocalStreams = this._shimmedLocalStreams || {};
    if (sender) {
      Object.keys(this._shimmedLocalStreams).forEach(function (streamId) {
        var idx = _this10._shimmedLocalStreams[streamId].indexOf(sender);
        if (idx !== -1) {
          _this10._shimmedLocalStreams[streamId].splice(idx, 1);
        }
        if (_this10._shimmedLocalStreams[streamId].length === 1) {
          delete _this10._shimmedLocalStreams[streamId];
        }
      });
    }
    return origRemoveTrack.apply(this, arguments);
  };
}

function shimAddTrackRemoveTrack(window) {
  if (!window.RTCPeerConnection) {
    return;
  }
  var browserDetails = utils.detectBrowser(window);
  // shim addTrack and removeTrack.
  if (window.RTCPeerConnection.prototype.addTrack && browserDetails.version >= 65) {
    return shimAddTrackRemoveTrackWithNative(window);
  }

  // also shim pc.getLocalStreams when addTrack is shimmed
  // to return the original streams.
  var origGetLocalStreams = window.RTCPeerConnection.prototype.getLocalStreams;
  window.RTCPeerConnection.prototype.getLocalStreams = function getLocalStreams() {
    var _this11 = this;

    var nativeStreams = origGetLocalStreams.apply(this);
    this._reverseStreams = this._reverseStreams || {};
    return nativeStreams.map(function (stream) {
      return _this11._reverseStreams[stream.id];
    });
  };

  var origAddStream = window.RTCPeerConnection.prototype.addStream;
  window.RTCPeerConnection.prototype.addStream = function addStream(stream) {
    var _this12 = this;

    this._streams = this._streams || {};
    this._reverseStreams = this._reverseStreams || {};

    stream.getTracks().forEach(function (track) {
      var alreadyExists = _this12.getSenders().find(function (s) {
        return s.track === track;
      });
      if (alreadyExists) {
        throw new DOMException('Track already exists.', 'InvalidAccessError');
      }
    });
    // Add identity mapping for consistency with addTrack.
    // Unless this is being used with a stream from addTrack.
    if (!this._reverseStreams[stream.id]) {
      var newStream = new window.MediaStream(stream.getTracks());
      this._streams[stream.id] = newStream;
      this._reverseStreams[newStream.id] = stream;
      stream = newStream;
    }
    origAddStream.apply(this, [stream]);
  };

  var origRemoveStream = window.RTCPeerConnection.prototype.removeStream;
  window.RTCPeerConnection.prototype.removeStream = function removeStream(stream) {
    this._streams = this._streams || {};
    this._reverseStreams = this._reverseStreams || {};

    origRemoveStream.apply(this, [this._streams[stream.id] || stream]);
    delete this._reverseStreams[this._streams[stream.id] ? this._streams[stream.id].id : stream.id];
    delete this._streams[stream.id];
  };

  window.RTCPeerConnection.prototype.addTrack = function addTrack(track, stream) {
    var _this13 = this;

    if (this.signalingState === 'closed') {
      throw new DOMException('The RTCPeerConnection\'s signalingState is \'closed\'.', 'InvalidStateError');
    }
    var streams = [].slice.call(arguments, 1);
    if (streams.length !== 1 || !streams[0].getTracks().find(function (t) {
      return t === track;
    })) {
      // this is not fully correct but all we can manage without
      // [[associated MediaStreams]] internal slot.
      throw new DOMException('The adapter.js addTrack polyfill only supports a single ' + ' stream which is associated with the specified track.', 'NotSupportedError');
    }

    var alreadyExists = this.getSenders().find(function (s) {
      return s.track === track;
    });
    if (alreadyExists) {
      throw new DOMException('Track already exists.', 'InvalidAccessError');
    }

    this._streams = this._streams || {};
    this._reverseStreams = this._reverseStreams || {};
    var oldStream = this._streams[stream.id];
    if (oldStream) {
      // this is using odd Chrome behaviour, use with caution:
      // https://bugs.chromium.org/p/webrtc/issues/detail?id=7815
      // Note: we rely on the high-level addTrack/dtmf shim to
      // create the sender with a dtmf sender.
      oldStream.addTrack(track);

      // Trigger ONN async.
      Promise.resolve().then(function () {
        _this13.dispatchEvent(new Event('negotiationneeded'));
      });
    } else {
      var newStream = new window.MediaStream([track]);
      this._streams[stream.id] = newStream;
      this._reverseStreams[newStream.id] = stream;
      this.addStream(newStream);
    }
    return this.getSenders().find(function (s) {
      return s.track === track;
    });
  };

  // replace the internal stream id with the external one and
  // vice versa.
  function replaceInternalStreamId(pc, description) {
    var sdp = description.sdp;
    Object.keys(pc._reverseStreams || []).forEach(function (internalId) {
      var externalStream = pc._reverseStreams[internalId];
      var internalStream = pc._streams[externalStream.id];
      sdp = sdp.replace(new RegExp(internalStream.id, 'g'), externalStream.id);
    });
    return new RTCSessionDescription({
      type: description.type,
      sdp: sdp
    });
  }
  function replaceExternalStreamId(pc, description) {
    var sdp = description.sdp;
    Object.keys(pc._reverseStreams || []).forEach(function (internalId) {
      var externalStream = pc._reverseStreams[internalId];
      var internalStream = pc._streams[externalStream.id];
      sdp = sdp.replace(new RegExp(externalStream.id, 'g'), internalStream.id);
    });
    return new RTCSessionDescription({
      type: description.type,
      sdp: sdp
    });
  }
  ['createOffer', 'createAnswer'].forEach(function (method) {
    var nativeMethod = window.RTCPeerConnection.prototype[method];
    var methodObj = _defineProperty({}, method, function () {
      var _this14 = this;

      var args = arguments;
      var isLegacyCall = arguments.length && typeof arguments[0] === 'function';
      if (isLegacyCall) {
        return nativeMethod.apply(this, [function (description) {
          var desc = replaceInternalStreamId(_this14, description);
          args[0].apply(null, [desc]);
        }, function (err) {
          if (args[1]) {
            args[1].apply(null, err);
          }
        }, arguments[2]]);
      }
      return nativeMethod.apply(this, arguments).then(function (description) {
        return replaceInternalStreamId(_this14, description);
      });
    });
    window.RTCPeerConnection.prototype[method] = methodObj[method];
  });

  var origSetLocalDescription = window.RTCPeerConnection.prototype.setLocalDescription;
  window.RTCPeerConnection.prototype.setLocalDescription = function setLocalDescription() {
    if (!arguments.length || !arguments[0].type) {
      return origSetLocalDescription.apply(this, arguments);
    }
    arguments[0] = replaceExternalStreamId(this, arguments[0]);
    return origSetLocalDescription.apply(this, arguments);
  };

  // TODO: mangle getStats: https://w3c.github.io/webrtc-stats/#dom-rtcmediastreamstats-streamidentifier

  var origLocalDescription = Object.getOwnPropertyDescriptor(window.RTCPeerConnection.prototype, 'localDescription');
  Object.defineProperty(window.RTCPeerConnection.prototype, 'localDescription', {
    get: function get() {
      var description = origLocalDescription.get.apply(this);
      if (description.type === '') {
        return description;
      }
      return replaceInternalStreamId(this, description);
    }
  });

  window.RTCPeerConnection.prototype.removeTrack = function removeTrack(sender) {
    var _this15 = this;

    if (this.signalingState === 'closed') {
      throw new DOMException('The RTCPeerConnection\'s signalingState is \'closed\'.', 'InvalidStateError');
    }
    // We can not yet check for sender instanceof RTCRtpSender
    // since we shim RTPSender. So we check if sender._pc is set.
    if (!sender._pc) {
      throw new DOMException('Argument 1 of RTCPeerConnection.removeTrack ' + 'does not implement interface RTCRtpSender.', 'TypeError');
    }
    var isLocal = sender._pc === this;
    if (!isLocal) {
      throw new DOMException('Sender was not created by this connection.', 'InvalidAccessError');
    }

    // Search for the native stream the senders track belongs to.
    this._streams = this._streams || {};
    var stream = void 0;
    Object.keys(this._streams).forEach(function (streamid) {
      var hasTrack = _this15._streams[streamid].getTracks().find(function (track) {
        return sender.track === track;
      });
      if (hasTrack) {
        stream = _this15._streams[streamid];
      }
    });

    if (stream) {
      if (stream.getTracks().length === 1) {
        // if this is the last track of the stream, remove the stream. This
        // takes care of any shimmed _senders.
        this.removeStream(this._reverseStreams[stream.id]);
      } else {
        // relying on the same odd chrome behaviour as above.
        stream.removeTrack(sender.track);
      }
      this.dispatchEvent(new Event('negotiationneeded'));
    }
  };
}

function shimPeerConnection(window) {
  var browserDetails = utils.detectBrowser(window);

  if (!window.RTCPeerConnection && window.webkitRTCPeerConnection) {
    // very basic support for old versions.
    window.RTCPeerConnection = window.webkitRTCPeerConnection;
  }
  if (!window.RTCPeerConnection) {
    return;
  }

  // shim implicit creation of RTCSessionDescription/RTCIceCandidate
  if (browserDetails.version < 53) {
    ['setLocalDescription', 'setRemoteDescription', 'addIceCandidate'].forEach(function (method) {
      var nativeMethod = window.RTCPeerConnection.prototype[method];
      var methodObj = _defineProperty({}, method, function () {
        arguments[0] = new (method === 'addIceCandidate' ? window.RTCIceCandidate : window.RTCSessionDescription)(arguments[0]);
        return nativeMethod.apply(this, arguments);
      });
      window.RTCPeerConnection.prototype[method] = methodObj[method];
    });
  }

  // support for addIceCandidate(null or undefined)
  var nativeAddIceCandidate = window.RTCPeerConnection.prototype.addIceCandidate;
  window.RTCPeerConnection.prototype.addIceCandidate = function addIceCandidate() {
    if (!arguments[0]) {
      if (arguments[1]) {
        arguments[1].apply(null);
      }
      return Promise.resolve();
    }
    // Firefox 68+ emits and processes {candidate: "", ...}, ignore
    // in older versions. Native support planned for Chrome M77.
    if (browserDetails.version < 78 && arguments[0] && arguments[0].candidate === '') {
      return Promise.resolve();
    }
    return nativeAddIceCandidate.apply(this, arguments);
  };
}

function fixNegotiationNeeded(window) {
  utils.wrapPeerConnectionEvent(window, 'negotiationneeded', function (e) {
    var pc = e.target;
    if (pc.signalingState !== 'stable') {
      return;
    }
    return e;
  });
}

},{"../utils.js":99,"./getdisplaymedia":88,"./getusermedia":89}],88:[function(require,module,exports){
/*
 *  Copyright (c) 2018 The adapter.js project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = shimGetDisplayMedia;
function shimGetDisplayMedia(window, getSourceId) {
  if (window.navigator.mediaDevices && 'getDisplayMedia' in window.navigator.mediaDevices) {
    return;
  }
  if (!window.navigator.mediaDevices) {
    return;
  }
  // getSourceId is a function that returns a promise resolving with
  // the sourceId of the screen/window/tab to be shared.
  if (typeof getSourceId !== 'function') {
    console.error('shimGetDisplayMedia: getSourceId argument is not ' + 'a function');
    return;
  }
  window.navigator.mediaDevices.getDisplayMedia = function getDisplayMedia(constraints) {
    return getSourceId(constraints).then(function (sourceId) {
      var widthSpecified = constraints.video && constraints.video.width;
      var heightSpecified = constraints.video && constraints.video.height;
      var frameRateSpecified = constraints.video && constraints.video.frameRate;
      constraints.video = {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: frameRateSpecified || 3
        }
      };
      if (widthSpecified) {
        constraints.video.mandatory.maxWidth = widthSpecified;
      }
      if (heightSpecified) {
        constraints.video.mandatory.maxHeight = heightSpecified;
      }
      return window.navigator.mediaDevices.getUserMedia(constraints);
    });
  };
}

},{}],89:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.shimGetUserMedia = shimGetUserMedia;

var _utils = require('../utils.js');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

var logging = utils.log;

function shimGetUserMedia(window) {
  var navigator = window && window.navigator;

  if (!navigator.mediaDevices) {
    return;
  }

  var browserDetails = utils.detectBrowser(window);

  var constraintsToChrome_ = function constraintsToChrome_(c) {
    if ((typeof c === 'undefined' ? 'undefined' : _typeof(c)) !== 'object' || c.mandatory || c.optional) {
      return c;
    }
    var cc = {};
    Object.keys(c).forEach(function (key) {
      if (key === 'require' || key === 'advanced' || key === 'mediaSource') {
        return;
      }
      var r = _typeof(c[key]) === 'object' ? c[key] : { ideal: c[key] };
      if (r.exact !== undefined && typeof r.exact === 'number') {
        r.min = r.max = r.exact;
      }
      var oldname_ = function oldname_(prefix, name) {
        if (prefix) {
          return prefix + name.charAt(0).toUpperCase() + name.slice(1);
        }
        return name === 'deviceId' ? 'sourceId' : name;
      };
      if (r.ideal !== undefined) {
        cc.optional = cc.optional || [];
        var oc = {};
        if (typeof r.ideal === 'number') {
          oc[oldname_('min', key)] = r.ideal;
          cc.optional.push(oc);
          oc = {};
          oc[oldname_('max', key)] = r.ideal;
          cc.optional.push(oc);
        } else {
          oc[oldname_('', key)] = r.ideal;
          cc.optional.push(oc);
        }
      }
      if (r.exact !== undefined && typeof r.exact !== 'number') {
        cc.mandatory = cc.mandatory || {};
        cc.mandatory[oldname_('', key)] = r.exact;
      } else {
        ['min', 'max'].forEach(function (mix) {
          if (r[mix] !== undefined) {
            cc.mandatory = cc.mandatory || {};
            cc.mandatory[oldname_(mix, key)] = r[mix];
          }
        });
      }
    });
    if (c.advanced) {
      cc.optional = (cc.optional || []).concat(c.advanced);
    }
    return cc;
  };

  var shimConstraints_ = function shimConstraints_(constraints, func) {
    if (browserDetails.version >= 61) {
      return func(constraints);
    }
    constraints = JSON.parse(JSON.stringify(constraints));
    if (constraints && _typeof(constraints.audio) === 'object') {
      var remap = function remap(obj, a, b) {
        if (a in obj && !(b in obj)) {
          obj[b] = obj[a];
          delete obj[a];
        }
      };
      constraints = JSON.parse(JSON.stringify(constraints));
      remap(constraints.audio, 'autoGainControl', 'googAutoGainControl');
      remap(constraints.audio, 'noiseSuppression', 'googNoiseSuppression');
      constraints.audio = constraintsToChrome_(constraints.audio);
    }
    if (constraints && _typeof(constraints.video) === 'object') {
      // Shim facingMode for mobile & surface pro.
      var face = constraints.video.facingMode;
      face = face && ((typeof face === 'undefined' ? 'undefined' : _typeof(face)) === 'object' ? face : { ideal: face });
      var getSupportedFacingModeLies = browserDetails.version < 66;

      if (face && (face.exact === 'user' || face.exact === 'environment' || face.ideal === 'user' || face.ideal === 'environment') && !(navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints().facingMode && !getSupportedFacingModeLies)) {
        delete constraints.video.facingMode;
        var matches = void 0;
        if (face.exact === 'environment' || face.ideal === 'environment') {
          matches = ['back', 'rear'];
        } else if (face.exact === 'user' || face.ideal === 'user') {
          matches = ['front'];
        }
        if (matches) {
          // Look for matches in label, or use last cam for back (typical).
          return navigator.mediaDevices.enumerateDevices().then(function (devices) {
            devices = devices.filter(function (d) {
              return d.kind === 'videoinput';
            });
            var dev = devices.find(function (d) {
              return matches.some(function (match) {
                return d.label.toLowerCase().includes(match);
              });
            });
            if (!dev && devices.length && matches.includes('back')) {
              dev = devices[devices.length - 1]; // more likely the back cam
            }
            if (dev) {
              constraints.video.deviceId = face.exact ? { exact: dev.deviceId } : { ideal: dev.deviceId };
            }
            constraints.video = constraintsToChrome_(constraints.video);
            logging('chrome: ' + JSON.stringify(constraints));
            return func(constraints);
          });
        }
      }
      constraints.video = constraintsToChrome_(constraints.video);
    }
    logging('chrome: ' + JSON.stringify(constraints));
    return func(constraints);
  };

  var shimError_ = function shimError_(e) {
    if (browserDetails.version >= 64) {
      return e;
    }
    return {
      name: {
        PermissionDeniedError: 'NotAllowedError',
        PermissionDismissedError: 'NotAllowedError',
        InvalidStateError: 'NotAllowedError',
        DevicesNotFoundError: 'NotFoundError',
        ConstraintNotSatisfiedError: 'OverconstrainedError',
        TrackStartError: 'NotReadableError',
        MediaDeviceFailedDueToShutdown: 'NotAllowedError',
        MediaDeviceKillSwitchOn: 'NotAllowedError',
        TabCaptureError: 'AbortError',
        ScreenCaptureError: 'AbortError',
        DeviceCaptureError: 'AbortError'
      }[e.name] || e.name,
      message: e.message,
      constraint: e.constraint || e.constraintName,
      toString: function toString() {
        return this.name + (this.message && ': ') + this.message;
      }
    };
  };

  var getUserMedia_ = function getUserMedia_(constraints, onSuccess, onError) {
    shimConstraints_(constraints, function (c) {
      navigator.webkitGetUserMedia(c, onSuccess, function (e) {
        if (onError) {
          onError(shimError_(e));
        }
      });
    });
  };
  navigator.getUserMedia = getUserMedia_.bind(navigator);

  // Even though Chrome 45 has navigator.mediaDevices and a getUserMedia
  // function which returns a Promise, it does not accept spec-style
  // constraints.
  if (navigator.mediaDevices.getUserMedia) {
    var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (cs) {
      return shimConstraints_(cs, function (c) {
        return origGetUserMedia(c).then(function (stream) {
          if (c.audio && !stream.getAudioTracks().length || c.video && !stream.getVideoTracks().length) {
            stream.getTracks().forEach(function (track) {
              track.stop();
            });
            throw new DOMException('', 'NotFoundError');
          }
          return stream;
        }, function (e) {
          return Promise.reject(shimError_(e));
        });
      });
    };
  }
}

},{"../utils.js":99}],90:[function(require,module,exports){
/*
 *  Copyright (c) 2017 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.shimRTCIceCandidate = shimRTCIceCandidate;
exports.shimMaxMessageSize = shimMaxMessageSize;
exports.shimSendThrowTypeError = shimSendThrowTypeError;
exports.shimConnectionState = shimConnectionState;
exports.removeAllowExtmapMixed = removeAllowExtmapMixed;

var _sdp = require('sdp');

var _sdp2 = _interopRequireDefault(_sdp);

var _utils = require('./utils');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function shimRTCIceCandidate(window) {
  // foundation is arbitrarily chosen as an indicator for full support for
  // https://w3c.github.io/webrtc-pc/#rtcicecandidate-interface
  if (!window.RTCIceCandidate || window.RTCIceCandidate && 'foundation' in window.RTCIceCandidate.prototype) {
    return;
  }

  var NativeRTCIceCandidate = window.RTCIceCandidate;
  window.RTCIceCandidate = function RTCIceCandidate(args) {
    // Remove the a= which shouldn't be part of the candidate string.
    if ((typeof args === 'undefined' ? 'undefined' : _typeof(args)) === 'object' && args.candidate && args.candidate.indexOf('a=') === 0) {
      args = JSON.parse(JSON.stringify(args));
      args.candidate = args.candidate.substr(2);
    }

    if (args.candidate && args.candidate.length) {
      // Augment the native candidate with the parsed fields.
      var nativeCandidate = new NativeRTCIceCandidate(args);
      var parsedCandidate = _sdp2.default.parseCandidate(args.candidate);
      var augmentedCandidate = Object.assign(nativeCandidate, parsedCandidate);

      // Add a serializer that does not serialize the extra attributes.
      augmentedCandidate.toJSON = function toJSON() {
        return {
          candidate: augmentedCandidate.candidate,
          sdpMid: augmentedCandidate.sdpMid,
          sdpMLineIndex: augmentedCandidate.sdpMLineIndex,
          usernameFragment: augmentedCandidate.usernameFragment
        };
      };
      return augmentedCandidate;
    }
    return new NativeRTCIceCandidate(args);
  };
  window.RTCIceCandidate.prototype = NativeRTCIceCandidate.prototype;

  // Hook up the augmented candidate in onicecandidate and
  // addEventListener('icecandidate', ...)
  utils.wrapPeerConnectionEvent(window, 'icecandidate', function (e) {
    if (e.candidate) {
      Object.defineProperty(e, 'candidate', {
        value: new window.RTCIceCandidate(e.candidate),
        writable: 'false'
      });
    }
    return e;
  });
}

function shimMaxMessageSize(window) {
  if (!window.RTCPeerConnection) {
    return;
  }
  var browserDetails = utils.detectBrowser(window);

  if (!('sctp' in window.RTCPeerConnection.prototype)) {
    Object.defineProperty(window.RTCPeerConnection.prototype, 'sctp', {
      get: function get() {
        return typeof this._sctp === 'undefined' ? null : this._sctp;
      }
    });
  }

  var sctpInDescription = function sctpInDescription(description) {
    if (!description || !description.sdp) {
      return false;
    }
    var sections = _sdp2.default.splitSections(description.sdp);
    sections.shift();
    return sections.some(function (mediaSection) {
      var mLine = _sdp2.default.parseMLine(mediaSection);
      return mLine && mLine.kind === 'application' && mLine.protocol.indexOf('SCTP') !== -1;
    });
  };

  var getRemoteFirefoxVersion = function getRemoteFirefoxVersion(description) {
    // TODO: Is there a better solution for detecting Firefox?
    var match = description.sdp.match(/mozilla...THIS_IS_SDPARTA-(\d+)/);
    if (match === null || match.length < 2) {
      return -1;
    }
    var version = parseInt(match[1], 10);
    // Test for NaN (yes, this is ugly)
    return version !== version ? -1 : version;
  };

  var getCanSendMaxMessageSize = function getCanSendMaxMessageSize(remoteIsFirefox) {
    // Every implementation we know can send at least 64 KiB.
    // Note: Although Chrome is technically able to send up to 256 KiB, the
    //       data does not reach the other peer reliably.
    //       See: https://bugs.chromium.org/p/webrtc/issues/detail?id=8419
    var canSendMaxMessageSize = 65536;
    if (browserDetails.browser === 'firefox') {
      if (browserDetails.version < 57) {
        if (remoteIsFirefox === -1) {
          // FF < 57 will send in 16 KiB chunks using the deprecated PPID
          // fragmentation.
          canSendMaxMessageSize = 16384;
        } else {
          // However, other FF (and RAWRTC) can reassemble PPID-fragmented
          // messages. Thus, supporting ~2 GiB when sending.
          canSendMaxMessageSize = 2147483637;
        }
      } else if (browserDetails.version < 60) {
        // Currently, all FF >= 57 will reset the remote maximum message size
        // to the default value when a data channel is created at a later
        // stage. :(
        // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1426831
        canSendMaxMessageSize = browserDetails.version === 57 ? 65535 : 65536;
      } else {
        // FF >= 60 supports sending ~2 GiB
        canSendMaxMessageSize = 2147483637;
      }
    }
    return canSendMaxMessageSize;
  };

  var getMaxMessageSize = function getMaxMessageSize(description, remoteIsFirefox) {
    // Note: 65536 bytes is the default value from the SDP spec. Also,
    //       every implementation we know supports receiving 65536 bytes.
    var maxMessageSize = 65536;

    // FF 57 has a slightly incorrect default remote max message size, so
    // we need to adjust it here to avoid a failure when sending.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1425697
    if (browserDetails.browser === 'firefox' && browserDetails.version === 57) {
      maxMessageSize = 65535;
    }

    var match = _sdp2.default.matchPrefix(description.sdp, 'a=max-message-size:');
    if (match.length > 0) {
      maxMessageSize = parseInt(match[0].substr(19), 10);
    } else if (browserDetails.browser === 'firefox' && remoteIsFirefox !== -1) {
      // If the maximum message size is not present in the remote SDP and
      // both local and remote are Firefox, the remote peer can receive
      // ~2 GiB.
      maxMessageSize = 2147483637;
    }
    return maxMessageSize;
  };

  var origSetRemoteDescription = window.RTCPeerConnection.prototype.setRemoteDescription;
  window.RTCPeerConnection.prototype.setRemoteDescription = function setRemoteDescription() {
    this._sctp = null;
    // Chrome decided to not expose .sctp in plan-b mode.
    // As usual, adapter.js has to do an 'ugly worakaround'
    // to cover up the mess.
    if (browserDetails.browser === 'chrome' && browserDetails.version >= 76) {
      var _getConfiguration = this.getConfiguration(),
          sdpSemantics = _getConfiguration.sdpSemantics;

      if (sdpSemantics === 'plan-b') {
        Object.defineProperty(this, 'sctp', {
          get: function get() {
            return typeof this._sctp === 'undefined' ? null : this._sctp;
          },

          enumerable: true,
          configurable: true
        });
      }
    }

    if (sctpInDescription(arguments[0])) {
      // Check if the remote is FF.
      var isFirefox = getRemoteFirefoxVersion(arguments[0]);

      // Get the maximum message size the local peer is capable of sending
      var canSendMMS = getCanSendMaxMessageSize(isFirefox);

      // Get the maximum message size of the remote peer.
      var remoteMMS = getMaxMessageSize(arguments[0], isFirefox);

      // Determine final maximum message size
      var maxMessageSize = void 0;
      if (canSendMMS === 0 && remoteMMS === 0) {
        maxMessageSize = Number.POSITIVE_INFINITY;
      } else if (canSendMMS === 0 || remoteMMS === 0) {
        maxMessageSize = Math.max(canSendMMS, remoteMMS);
      } else {
        maxMessageSize = Math.min(canSendMMS, remoteMMS);
      }

      // Create a dummy RTCSctpTransport object and the 'maxMessageSize'
      // attribute.
      var sctp = {};
      Object.defineProperty(sctp, 'maxMessageSize', {
        get: function get() {
          return maxMessageSize;
        }
      });
      this._sctp = sctp;
    }

    return origSetRemoteDescription.apply(this, arguments);
  };
}

function shimSendThrowTypeError(window) {
  if (!(window.RTCPeerConnection && 'createDataChannel' in window.RTCPeerConnection.prototype)) {
    return;
  }

  // Note: Although Firefox >= 57 has a native implementation, the maximum
  //       message size can be reset for all data channels at a later stage.
  //       See: https://bugzilla.mozilla.org/show_bug.cgi?id=1426831

  function wrapDcSend(dc, pc) {
    var origDataChannelSend = dc.send;
    dc.send = function send() {
      var data = arguments[0];
      var length = data.length || data.size || data.byteLength;
      if (dc.readyState === 'open' && pc.sctp && length > pc.sctp.maxMessageSize) {
        throw new TypeError('Message too large (can send a maximum of ' + pc.sctp.maxMessageSize + ' bytes)');
      }
      return origDataChannelSend.apply(dc, arguments);
    };
  }
  var origCreateDataChannel = window.RTCPeerConnection.prototype.createDataChannel;
  window.RTCPeerConnection.prototype.createDataChannel = function createDataChannel() {
    var dataChannel = origCreateDataChannel.apply(this, arguments);
    wrapDcSend(dataChannel, this);
    return dataChannel;
  };
  utils.wrapPeerConnectionEvent(window, 'datachannel', function (e) {
    wrapDcSend(e.channel, e.target);
    return e;
  });
}

/* shims RTCConnectionState by pretending it is the same as iceConnectionState.
 * See https://bugs.chromium.org/p/webrtc/issues/detail?id=6145#c12
 * for why this is a valid hack in Chrome. In Firefox it is slightly incorrect
 * since DTLS failures would be hidden. See
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1265827
 * for the Firefox tracking bug.
 */
function shimConnectionState(window) {
  if (!window.RTCPeerConnection || 'connectionState' in window.RTCPeerConnection.prototype) {
    return;
  }
  var proto = window.RTCPeerConnection.prototype;
  Object.defineProperty(proto, 'connectionState', {
    get: function get() {
      return {
        completed: 'connected',
        checking: 'connecting'
      }[this.iceConnectionState] || this.iceConnectionState;
    },

    enumerable: true,
    configurable: true
  });
  Object.defineProperty(proto, 'onconnectionstatechange', {
    get: function get() {
      return this._onconnectionstatechange || null;
    },
    set: function set(cb) {
      if (this._onconnectionstatechange) {
        this.removeEventListener('connectionstatechange', this._onconnectionstatechange);
        delete this._onconnectionstatechange;
      }
      if (cb) {
        this.addEventListener('connectionstatechange', this._onconnectionstatechange = cb);
      }
    },

    enumerable: true,
    configurable: true
  });

  ['setLocalDescription', 'setRemoteDescription'].forEach(function (method) {
    var origMethod = proto[method];
    proto[method] = function () {
      if (!this._connectionstatechangepoly) {
        this._connectionstatechangepoly = function (e) {
          var pc = e.target;
          if (pc._lastConnectionState !== pc.connectionState) {
            pc._lastConnectionState = pc.connectionState;
            var newEvent = new Event('connectionstatechange', e);
            pc.dispatchEvent(newEvent);
          }
          return e;
        };
        this.addEventListener('iceconnectionstatechange', this._connectionstatechangepoly);
      }
      return origMethod.apply(this, arguments);
    };
  });
}

function removeAllowExtmapMixed(window) {
  /* remove a=extmap-allow-mixed for Chrome < M71 */
  if (!window.RTCPeerConnection) {
    return;
  }
  var browserDetails = utils.detectBrowser(window);
  if (browserDetails.browser === 'chrome' && browserDetails.version >= 71) {
    return;
  }
  var nativeSRD = window.RTCPeerConnection.prototype.setRemoteDescription;
  window.RTCPeerConnection.prototype.setRemoteDescription = function setRemoteDescription(desc) {
    if (desc && desc.sdp && desc.sdp.indexOf('\na=extmap-allow-mixed') !== -1) {
      desc.sdp = desc.sdp.split('\n').filter(function (line) {
        return line.trim() !== 'a=extmap-allow-mixed';
      }).join('\n');
    }
    return nativeSRD.apply(this, arguments);
  };
}

},{"./utils":99,"sdp":58}],91:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = exports.shimGetUserMedia = undefined;

var _getusermedia = require('./getusermedia');

Object.defineProperty(exports, 'shimGetUserMedia', {
  enumerable: true,
  get: function get() {
    return _getusermedia.shimGetUserMedia;
  }
});

var _getdisplaymedia = require('./getdisplaymedia');

Object.defineProperty(exports, 'shimGetDisplayMedia', {
  enumerable: true,
  get: function get() {
    return _getdisplaymedia.shimGetDisplayMedia;
  }
});
exports.shimPeerConnection = shimPeerConnection;
exports.shimReplaceTrack = shimReplaceTrack;

var _utils = require('../utils');

var utils = _interopRequireWildcard(_utils);

var _filtericeservers = require('./filtericeservers');

var _rtcpeerconnectionShim = require('rtcpeerconnection-shim');

var _rtcpeerconnectionShim2 = _interopRequireDefault(_rtcpeerconnectionShim);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function shimPeerConnection(window) {
  var browserDetails = utils.detectBrowser(window);

  if (window.RTCIceGatherer) {
    if (!window.RTCIceCandidate) {
      window.RTCIceCandidate = function RTCIceCandidate(args) {
        return args;
      };
    }
    if (!window.RTCSessionDescription) {
      window.RTCSessionDescription = function RTCSessionDescription(args) {
        return args;
      };
    }
    // this adds an additional event listener to MediaStrackTrack that signals
    // when a tracks enabled property was changed. Workaround for a bug in
    // addStream, see below. No longer required in 15025+
    if (browserDetails.version < 15025) {
      var origMSTEnabled = Object.getOwnPropertyDescriptor(window.MediaStreamTrack.prototype, 'enabled');
      Object.defineProperty(window.MediaStreamTrack.prototype, 'enabled', {
        set: function set(value) {
          origMSTEnabled.set.call(this, value);
          var ev = new Event('enabled');
          ev.enabled = value;
          this.dispatchEvent(ev);
        }
      });
    }
  }

  // ORTC defines the DTMF sender a bit different.
  // https://github.com/w3c/ortc/issues/714
  if (window.RTCRtpSender && !('dtmf' in window.RTCRtpSender.prototype)) {
    Object.defineProperty(window.RTCRtpSender.prototype, 'dtmf', {
      get: function get() {
        if (this._dtmf === undefined) {
          if (this.track.kind === 'audio') {
            this._dtmf = new window.RTCDtmfSender(this);
          } else if (this.track.kind === 'video') {
            this._dtmf = null;
          }
        }
        return this._dtmf;
      }
    });
  }
  // Edge currently only implements the RTCDtmfSender, not the
  // RTCDTMFSender alias. See http://draft.ortc.org/#rtcdtmfsender2*
  if (window.RTCDtmfSender && !window.RTCDTMFSender) {
    window.RTCDTMFSender = window.RTCDtmfSender;
  }

  var RTCPeerConnectionShim = (0, _rtcpeerconnectionShim2.default)(window, browserDetails.version);
  window.RTCPeerConnection = function RTCPeerConnection(config) {
    if (config && config.iceServers) {
      config.iceServers = (0, _filtericeservers.filterIceServers)(config.iceServers, browserDetails.version);
      utils.log('ICE servers after filtering:', config.iceServers);
    }
    return new RTCPeerConnectionShim(config);
  };
  window.RTCPeerConnection.prototype = RTCPeerConnectionShim.prototype;
}

function shimReplaceTrack(window) {
  // ORTC has replaceTrack -- https://github.com/w3c/ortc/issues/614
  if (window.RTCRtpSender && !('replaceTrack' in window.RTCRtpSender.prototype)) {
    window.RTCRtpSender.prototype.replaceTrack = window.RTCRtpSender.prototype.setTrack;
  }
}

},{"../utils":99,"./filtericeservers":92,"./getdisplaymedia":93,"./getusermedia":94,"rtcpeerconnection-shim":57}],92:[function(require,module,exports){
/*
 *  Copyright (c) 2018 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.filterIceServers = filterIceServers;

var _utils = require('../utils');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

// Edge does not like
// 1) stun: filtered after 14393 unless ?transport=udp is present
// 2) turn: that does not have all of turn:host:port?transport=udp
// 3) turn: with ipv6 addresses
// 4) turn: occurring muliple times
function filterIceServers(iceServers, edgeVersion) {
  var hasTurn = false;
  iceServers = JSON.parse(JSON.stringify(iceServers));
  return iceServers.filter(function (server) {
    if (server && (server.urls || server.url)) {
      var urls = server.urls || server.url;
      if (server.url && !server.urls) {
        utils.deprecated('RTCIceServer.url', 'RTCIceServer.urls');
      }
      var isString = typeof urls === 'string';
      if (isString) {
        urls = [urls];
      }
      urls = urls.filter(function (url) {
        // filter STUN unconditionally.
        if (url.indexOf('stun:') === 0) {
          return false;
        }

        var validTurn = url.startsWith('turn') && !url.startsWith('turn:[') && url.includes('transport=udp');
        if (validTurn && !hasTurn) {
          hasTurn = true;
          return true;
        }
        return validTurn && !hasTurn;
      });

      delete server.url;
      server.urls = isString ? urls[0] : urls;
      return !!urls.length;
    }
  });
}

},{"../utils":99}],93:[function(require,module,exports){
/*
 *  Copyright (c) 2018 The adapter.js project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = shimGetDisplayMedia;
function shimGetDisplayMedia(window) {
  if (!('getDisplayMedia' in window.navigator)) {
    return;
  }
  if (!window.navigator.mediaDevices) {
    return;
  }
  if (window.navigator.mediaDevices && 'getDisplayMedia' in window.navigator.mediaDevices) {
    return;
  }
  window.navigator.mediaDevices.getDisplayMedia = window.navigator.getDisplayMedia.bind(window.navigator);
}

},{}],94:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetUserMedia = shimGetUserMedia;
function shimGetUserMedia(window) {
  var navigator = window && window.navigator;

  var shimError_ = function shimError_(e) {
    return {
      name: { PermissionDeniedError: 'NotAllowedError' }[e.name] || e.name,
      message: e.message,
      constraint: e.constraint,
      toString: function toString() {
        return this.name;
      }
    };
  };

  // getUserMedia error shim.
  var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = function (c) {
    return origGetUserMedia(c).catch(function (e) {
      return Promise.reject(shimError_(e));
    });
  };
}

},{}],95:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = exports.shimGetUserMedia = undefined;

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _getusermedia = require('./getusermedia');

Object.defineProperty(exports, 'shimGetUserMedia', {
  enumerable: true,
  get: function get() {
    return _getusermedia.shimGetUserMedia;
  }
});

var _getdisplaymedia = require('./getdisplaymedia');

Object.defineProperty(exports, 'shimGetDisplayMedia', {
  enumerable: true,
  get: function get() {
    return _getdisplaymedia.shimGetDisplayMedia;
  }
});
exports.shimOnTrack = shimOnTrack;
exports.shimPeerConnection = shimPeerConnection;
exports.shimSenderGetStats = shimSenderGetStats;
exports.shimReceiverGetStats = shimReceiverGetStats;
exports.shimRemoveStream = shimRemoveStream;
exports.shimRTCDataChannel = shimRTCDataChannel;
exports.shimAddTransceiver = shimAddTransceiver;
exports.shimCreateOffer = shimCreateOffer;
exports.shimCreateAnswer = shimCreateAnswer;

var _utils = require('../utils');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function shimOnTrack(window) {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCTrackEvent && 'receiver' in window.RTCTrackEvent.prototype && !('transceiver' in window.RTCTrackEvent.prototype)) {
    Object.defineProperty(window.RTCTrackEvent.prototype, 'transceiver', {
      get: function get() {
        return { receiver: this.receiver };
      }
    });
  }
}

function shimPeerConnection(window) {
  var browserDetails = utils.detectBrowser(window);

  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) !== 'object' || !(window.RTCPeerConnection || window.mozRTCPeerConnection)) {
    return; // probably media.peerconnection.enabled=false in about:config
  }
  if (!window.RTCPeerConnection && window.mozRTCPeerConnection) {
    // very basic support for old versions.
    window.RTCPeerConnection = window.mozRTCPeerConnection;
  }

  if (browserDetails.version < 53) {
    // shim away need for obsolete RTCIceCandidate/RTCSessionDescription.
    ['setLocalDescription', 'setRemoteDescription', 'addIceCandidate'].forEach(function (method) {
      var nativeMethod = window.RTCPeerConnection.prototype[method];
      var methodObj = _defineProperty({}, method, function () {
        arguments[0] = new (method === 'addIceCandidate' ? window.RTCIceCandidate : window.RTCSessionDescription)(arguments[0]);
        return nativeMethod.apply(this, arguments);
      });
      window.RTCPeerConnection.prototype[method] = methodObj[method];
    });
  }

  // support for addIceCandidate(null or undefined)
  // as well as ignoring {sdpMid, candidate: ""}
  if (browserDetails.version < 68) {
    var nativeAddIceCandidate = window.RTCPeerConnection.prototype.addIceCandidate;
    window.RTCPeerConnection.prototype.addIceCandidate = function addIceCandidate() {
      if (!arguments[0]) {
        if (arguments[1]) {
          arguments[1].apply(null);
        }
        return Promise.resolve();
      }
      // Firefox 68+ emits and processes {candidate: "", ...}, ignore
      // in older versions.
      if (arguments[0] && arguments[0].candidate === '') {
        return Promise.resolve();
      }
      return nativeAddIceCandidate.apply(this, arguments);
    };
  }

  var modernStatsTypes = {
    inboundrtp: 'inbound-rtp',
    outboundrtp: 'outbound-rtp',
    candidatepair: 'candidate-pair',
    localcandidate: 'local-candidate',
    remotecandidate: 'remote-candidate'
  };

  var nativeGetStats = window.RTCPeerConnection.prototype.getStats;
  window.RTCPeerConnection.prototype.getStats = function getStats() {
    var _arguments = Array.prototype.slice.call(arguments),
        selector = _arguments[0],
        onSucc = _arguments[1],
        onErr = _arguments[2];

    return nativeGetStats.apply(this, [selector || null]).then(function (stats) {
      if (browserDetails.version < 53 && !onSucc) {
        // Shim only promise getStats with spec-hyphens in type names
        // Leave callback version alone; misc old uses of forEach before Map
        try {
          stats.forEach(function (stat) {
            stat.type = modernStatsTypes[stat.type] || stat.type;
          });
        } catch (e) {
          if (e.name !== 'TypeError') {
            throw e;
          }
          // Avoid TypeError: "type" is read-only, in old versions. 34-43ish
          stats.forEach(function (stat, i) {
            stats.set(i, Object.assign({}, stat, {
              type: modernStatsTypes[stat.type] || stat.type
            }));
          });
        }
      }
      return stats;
    }).then(onSucc, onErr);
  };
}

function shimSenderGetStats(window) {
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && window.RTCRtpSender)) {
    return;
  }
  if (window.RTCRtpSender && 'getStats' in window.RTCRtpSender.prototype) {
    return;
  }
  var origGetSenders = window.RTCPeerConnection.prototype.getSenders;
  if (origGetSenders) {
    window.RTCPeerConnection.prototype.getSenders = function getSenders() {
      var _this = this;

      var senders = origGetSenders.apply(this, []);
      senders.forEach(function (sender) {
        return sender._pc = _this;
      });
      return senders;
    };
  }

  var origAddTrack = window.RTCPeerConnection.prototype.addTrack;
  if (origAddTrack) {
    window.RTCPeerConnection.prototype.addTrack = function addTrack() {
      var sender = origAddTrack.apply(this, arguments);
      sender._pc = this;
      return sender;
    };
  }
  window.RTCRtpSender.prototype.getStats = function getStats() {
    return this.track ? this._pc.getStats(this.track) : Promise.resolve(new Map());
  };
}

function shimReceiverGetStats(window) {
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection && window.RTCRtpSender)) {
    return;
  }
  if (window.RTCRtpSender && 'getStats' in window.RTCRtpReceiver.prototype) {
    return;
  }
  var origGetReceivers = window.RTCPeerConnection.prototype.getReceivers;
  if (origGetReceivers) {
    window.RTCPeerConnection.prototype.getReceivers = function getReceivers() {
      var _this2 = this;

      var receivers = origGetReceivers.apply(this, []);
      receivers.forEach(function (receiver) {
        return receiver._pc = _this2;
      });
      return receivers;
    };
  }
  utils.wrapPeerConnectionEvent(window, 'track', function (e) {
    e.receiver._pc = e.srcElement;
    return e;
  });
  window.RTCRtpReceiver.prototype.getStats = function getStats() {
    return this._pc.getStats(this.track);
  };
}

function shimRemoveStream(window) {
  if (!window.RTCPeerConnection || 'removeStream' in window.RTCPeerConnection.prototype) {
    return;
  }
  window.RTCPeerConnection.prototype.removeStream = function removeStream(stream) {
    var _this3 = this;

    utils.deprecated('removeStream', 'removeTrack');
    this.getSenders().forEach(function (sender) {
      if (sender.track && stream.getTracks().includes(sender.track)) {
        _this3.removeTrack(sender);
      }
    });
  };
}

function shimRTCDataChannel(window) {
  // rename DataChannel to RTCDataChannel (native fix in FF60):
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1173851
  if (window.DataChannel && !window.RTCDataChannel) {
    window.RTCDataChannel = window.DataChannel;
  }
}

function shimAddTransceiver(window) {
  // https://github.com/webrtcHacks/adapter/issues/998#issuecomment-516921647
  // Firefox ignores the init sendEncodings options passed to addTransceiver
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1396918
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection)) {
    return;
  }
  var origAddTransceiver = window.RTCPeerConnection.prototype.addTransceiver;
  if (origAddTransceiver) {
    window.RTCPeerConnection.prototype.addTransceiver = function addTransceiver() {
      this.setParametersPromises = [];
      var initParameters = arguments[1];
      var shouldPerformCheck = initParameters && 'sendEncodings' in initParameters;
      if (shouldPerformCheck) {
        // If sendEncodings params are provided, validate grammar
        initParameters.sendEncodings.forEach(function (encodingParam) {
          if ('rid' in encodingParam) {
            var ridRegex = /^[a-z0-9]{0,16}$/i;
            if (!ridRegex.test(encodingParam.rid)) {
              throw new TypeError('Invalid RID value provided.');
            }
          }
          if ('scaleResolutionDownBy' in encodingParam) {
            if (!(parseFloat(encodingParam.scaleResolutionDownBy) >= 1.0)) {
              throw new RangeError('scale_resolution_down_by must be >= 1.0');
            }
          }
          if ('maxFramerate' in encodingParam) {
            if (!(parseFloat(encodingParam.maxFramerate) >= 0)) {
              throw new RangeError('max_framerate must be >= 0.0');
            }
          }
        });
      }
      var transceiver = origAddTransceiver.apply(this, arguments);
      if (shouldPerformCheck) {
        // Check if the init options were applied. If not we do this in an
        // asynchronous way and save the promise reference in a global object.
        // This is an ugly hack, but at the same time is way more robust than
        // checking the sender parameters before and after the createOffer
        // Also note that after the createoffer we are not 100% sure that
        // the params were asynchronously applied so we might miss the
        // opportunity to recreate offer.
        var sender = transceiver.sender;

        var params = sender.getParameters();
        if (!('encodings' in params)) {
          params.encodings = initParameters.sendEncodings;
          this.setParametersPromises.push(sender.setParameters(params).catch(function () {}));
        }
      }
      return transceiver;
    };
  }
}

function shimCreateOffer(window) {
  // https://github.com/webrtcHacks/adapter/issues/998#issuecomment-516921647
  // Firefox ignores the init sendEncodings options passed to addTransceiver
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1396918
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection)) {
    return;
  }
  var origCreateOffer = window.RTCPeerConnection.prototype.createOffer;
  window.RTCPeerConnection.prototype.createOffer = function createOffer() {
    var _this4 = this,
        _arguments2 = arguments;

    if (this.setParametersPromises && this.setParametersPromises.length) {
      return Promise.all(this.setParametersPromises).then(function () {
        return origCreateOffer.apply(_this4, _arguments2);
      }).finally(function () {
        _this4.setParametersPromises = [];
      });
    }
    return origCreateOffer.apply(this, arguments);
  };
}

function shimCreateAnswer(window) {
  // https://github.com/webrtcHacks/adapter/issues/998#issuecomment-516921647
  // Firefox ignores the init sendEncodings options passed to addTransceiver
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1396918
  if (!((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCPeerConnection)) {
    return;
  }
  var origCreateAnswer = window.RTCPeerConnection.prototype.createAnswer;
  window.RTCPeerConnection.prototype.createAnswer = function createAnswer() {
    var _this5 = this,
        _arguments3 = arguments;

    if (this.setParametersPromises && this.setParametersPromises.length) {
      return Promise.all(this.setParametersPromises).then(function () {
        return origCreateAnswer.apply(_this5, _arguments3);
      }).finally(function () {
        _this5.setParametersPromises = [];
      });
    }
    return origCreateAnswer.apply(this, arguments);
  };
}

},{"../utils":99,"./getdisplaymedia":96,"./getusermedia":97}],96:[function(require,module,exports){
/*
 *  Copyright (c) 2018 The adapter.js project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shimGetDisplayMedia = shimGetDisplayMedia;
function shimGetDisplayMedia(window, preferredMediaSource) {
  if (window.navigator.mediaDevices && 'getDisplayMedia' in window.navigator.mediaDevices) {
    return;
  }
  if (!window.navigator.mediaDevices) {
    return;
  }
  window.navigator.mediaDevices.getDisplayMedia = function getDisplayMedia(constraints) {
    if (!(constraints && constraints.video)) {
      var err = new DOMException('getDisplayMedia without video ' + 'constraints is undefined');
      err.name = 'NotFoundError';
      // from https://heycam.github.io/webidl/#idl-DOMException-error-names
      err.code = 8;
      return Promise.reject(err);
    }
    if (constraints.video === true) {
      constraints.video = { mediaSource: preferredMediaSource };
    } else {
      constraints.video.mediaSource = preferredMediaSource;
    }
    return window.navigator.mediaDevices.getUserMedia(constraints);
  };
}

},{}],97:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.shimGetUserMedia = shimGetUserMedia;

var _utils = require('../utils');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function shimGetUserMedia(window) {
  var browserDetails = utils.detectBrowser(window);
  var navigator = window && window.navigator;
  var MediaStreamTrack = window && window.MediaStreamTrack;

  navigator.getUserMedia = function (constraints, onSuccess, onError) {
    // Replace Firefox 44+'s deprecation warning with unprefixed version.
    utils.deprecated('navigator.getUserMedia', 'navigator.mediaDevices.getUserMedia');
    navigator.mediaDevices.getUserMedia(constraints).then(onSuccess, onError);
  };

  if (!(browserDetails.version > 55 && 'autoGainControl' in navigator.mediaDevices.getSupportedConstraints())) {
    var remap = function remap(obj, a, b) {
      if (a in obj && !(b in obj)) {
        obj[b] = obj[a];
        delete obj[a];
      }
    };

    var nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (c) {
      if ((typeof c === 'undefined' ? 'undefined' : _typeof(c)) === 'object' && _typeof(c.audio) === 'object') {
        c = JSON.parse(JSON.stringify(c));
        remap(c.audio, 'autoGainControl', 'mozAutoGainControl');
        remap(c.audio, 'noiseSuppression', 'mozNoiseSuppression');
      }
      return nativeGetUserMedia(c);
    };

    if (MediaStreamTrack && MediaStreamTrack.prototype.getSettings) {
      var nativeGetSettings = MediaStreamTrack.prototype.getSettings;
      MediaStreamTrack.prototype.getSettings = function () {
        var obj = nativeGetSettings.apply(this, arguments);
        remap(obj, 'mozAutoGainControl', 'autoGainControl');
        remap(obj, 'mozNoiseSuppression', 'noiseSuppression');
        return obj;
      };
    }

    if (MediaStreamTrack && MediaStreamTrack.prototype.applyConstraints) {
      var nativeApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
      MediaStreamTrack.prototype.applyConstraints = function (c) {
        if (this.kind === 'audio' && (typeof c === 'undefined' ? 'undefined' : _typeof(c)) === 'object') {
          c = JSON.parse(JSON.stringify(c));
          remap(c, 'autoGainControl', 'mozAutoGainControl');
          remap(c, 'noiseSuppression', 'mozNoiseSuppression');
        }
        return nativeApplyConstraints.apply(this, [c]);
      };
    }
  }
}

},{"../utils":99}],98:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.shimLocalStreamsAPI = shimLocalStreamsAPI;
exports.shimRemoteStreamsAPI = shimRemoteStreamsAPI;
exports.shimCallbacksAPI = shimCallbacksAPI;
exports.shimGetUserMedia = shimGetUserMedia;
exports.shimConstraints = shimConstraints;
exports.shimRTCIceServerUrls = shimRTCIceServerUrls;
exports.shimTrackEventTransceiver = shimTrackEventTransceiver;
exports.shimCreateOfferLegacy = shimCreateOfferLegacy;

var _utils = require('../utils');

var utils = _interopRequireWildcard(_utils);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function shimLocalStreamsAPI(window) {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) !== 'object' || !window.RTCPeerConnection) {
    return;
  }
  if (!('getLocalStreams' in window.RTCPeerConnection.prototype)) {
    window.RTCPeerConnection.prototype.getLocalStreams = function getLocalStreams() {
      if (!this._localStreams) {
        this._localStreams = [];
      }
      return this._localStreams;
    };
  }
  if (!('addStream' in window.RTCPeerConnection.prototype)) {
    var _addTrack = window.RTCPeerConnection.prototype.addTrack;
    window.RTCPeerConnection.prototype.addStream = function addStream(stream) {
      var _this = this;

      if (!this._localStreams) {
        this._localStreams = [];
      }
      if (!this._localStreams.includes(stream)) {
        this._localStreams.push(stream);
      }
      // Try to emulate Chrome's behaviour of adding in audio-video order.
      // Safari orders by track id.
      stream.getAudioTracks().forEach(function (track) {
        return _addTrack.call(_this, track, stream);
      });
      stream.getVideoTracks().forEach(function (track) {
        return _addTrack.call(_this, track, stream);
      });
    };

    window.RTCPeerConnection.prototype.addTrack = function addTrack(track) {
      var stream = arguments[1];
      if (stream) {
        if (!this._localStreams) {
          this._localStreams = [stream];
        } else if (!this._localStreams.includes(stream)) {
          this._localStreams.push(stream);
        }
      }
      return _addTrack.apply(this, arguments);
    };
  }
  if (!('removeStream' in window.RTCPeerConnection.prototype)) {
    window.RTCPeerConnection.prototype.removeStream = function removeStream(stream) {
      var _this2 = this;

      if (!this._localStreams) {
        this._localStreams = [];
      }
      var index = this._localStreams.indexOf(stream);
      if (index === -1) {
        return;
      }
      this._localStreams.splice(index, 1);
      var tracks = stream.getTracks();
      this.getSenders().forEach(function (sender) {
        if (tracks.includes(sender.track)) {
          _this2.removeTrack(sender);
        }
      });
    };
  }
}

function shimRemoteStreamsAPI(window) {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) !== 'object' || !window.RTCPeerConnection) {
    return;
  }
  if (!('getRemoteStreams' in window.RTCPeerConnection.prototype)) {
    window.RTCPeerConnection.prototype.getRemoteStreams = function getRemoteStreams() {
      return this._remoteStreams ? this._remoteStreams : [];
    };
  }
  if (!('onaddstream' in window.RTCPeerConnection.prototype)) {
    Object.defineProperty(window.RTCPeerConnection.prototype, 'onaddstream', {
      get: function get() {
        return this._onaddstream;
      },
      set: function set(f) {
        var _this3 = this;

        if (this._onaddstream) {
          this.removeEventListener('addstream', this._onaddstream);
          this.removeEventListener('track', this._onaddstreampoly);
        }
        this.addEventListener('addstream', this._onaddstream = f);
        this.addEventListener('track', this._onaddstreampoly = function (e) {
          e.streams.forEach(function (stream) {
            if (!_this3._remoteStreams) {
              _this3._remoteStreams = [];
            }
            if (_this3._remoteStreams.includes(stream)) {
              return;
            }
            _this3._remoteStreams.push(stream);
            var event = new Event('addstream');
            event.stream = stream;
            _this3.dispatchEvent(event);
          });
        });
      }
    });
    var origSetRemoteDescription = window.RTCPeerConnection.prototype.setRemoteDescription;
    window.RTCPeerConnection.prototype.setRemoteDescription = function setRemoteDescription() {
      var pc = this;
      if (!this._onaddstreampoly) {
        this.addEventListener('track', this._onaddstreampoly = function (e) {
          e.streams.forEach(function (stream) {
            if (!pc._remoteStreams) {
              pc._remoteStreams = [];
            }
            if (pc._remoteStreams.indexOf(stream) >= 0) {
              return;
            }
            pc._remoteStreams.push(stream);
            var event = new Event('addstream');
            event.stream = stream;
            pc.dispatchEvent(event);
          });
        });
      }
      return origSetRemoteDescription.apply(pc, arguments);
    };
  }
}

function shimCallbacksAPI(window) {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) !== 'object' || !window.RTCPeerConnection) {
    return;
  }
  var prototype = window.RTCPeerConnection.prototype;
  var origCreateOffer = prototype.createOffer;
  var origCreateAnswer = prototype.createAnswer;
  var setLocalDescription = prototype.setLocalDescription;
  var setRemoteDescription = prototype.setRemoteDescription;
  var addIceCandidate = prototype.addIceCandidate;

  prototype.createOffer = function createOffer(successCallback, failureCallback) {
    var options = arguments.length >= 2 ? arguments[2] : arguments[0];
    var promise = origCreateOffer.apply(this, [options]);
    if (!failureCallback) {
      return promise;
    }
    promise.then(successCallback, failureCallback);
    return Promise.resolve();
  };

  prototype.createAnswer = function createAnswer(successCallback, failureCallback) {
    var options = arguments.length >= 2 ? arguments[2] : arguments[0];
    var promise = origCreateAnswer.apply(this, [options]);
    if (!failureCallback) {
      return promise;
    }
    promise.then(successCallback, failureCallback);
    return Promise.resolve();
  };

  var withCallback = function withCallback(description, successCallback, failureCallback) {
    var promise = setLocalDescription.apply(this, [description]);
    if (!failureCallback) {
      return promise;
    }
    promise.then(successCallback, failureCallback);
    return Promise.resolve();
  };
  prototype.setLocalDescription = withCallback;

  withCallback = function withCallback(description, successCallback, failureCallback) {
    var promise = setRemoteDescription.apply(this, [description]);
    if (!failureCallback) {
      return promise;
    }
    promise.then(successCallback, failureCallback);
    return Promise.resolve();
  };
  prototype.setRemoteDescription = withCallback;

  withCallback = function withCallback(candidate, successCallback, failureCallback) {
    var promise = addIceCandidate.apply(this, [candidate]);
    if (!failureCallback) {
      return promise;
    }
    promise.then(successCallback, failureCallback);
    return Promise.resolve();
  };
  prototype.addIceCandidate = withCallback;
}

function shimGetUserMedia(window) {
  var navigator = window && window.navigator;

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // shim not needed in Safari 12.1
    var mediaDevices = navigator.mediaDevices;
    var _getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      return _getUserMedia(shimConstraints(constraints));
    };
  }

  if (!navigator.getUserMedia && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.getUserMedia = function getUserMedia(constraints, cb, errcb) {
      navigator.mediaDevices.getUserMedia(constraints).then(cb, errcb);
    }.bind(navigator);
  }
}

function shimConstraints(constraints) {
  if (constraints && constraints.video !== undefined) {
    return Object.assign({}, constraints, { video: utils.compactObject(constraints.video) });
  }

  return constraints;
}

function shimRTCIceServerUrls(window) {
  // migrate from non-spec RTCIceServer.url to RTCIceServer.urls
  var OrigPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = function RTCPeerConnection(pcConfig, pcConstraints) {
    if (pcConfig && pcConfig.iceServers) {
      var newIceServers = [];
      for (var i = 0; i < pcConfig.iceServers.length; i++) {
        var server = pcConfig.iceServers[i];
        if (!server.hasOwnProperty('urls') && server.hasOwnProperty('url')) {
          utils.deprecated('RTCIceServer.url', 'RTCIceServer.urls');
          server = JSON.parse(JSON.stringify(server));
          server.urls = server.url;
          delete server.url;
          newIceServers.push(server);
        } else {
          newIceServers.push(pcConfig.iceServers[i]);
        }
      }
      pcConfig.iceServers = newIceServers;
    }
    return new OrigPeerConnection(pcConfig, pcConstraints);
  };
  window.RTCPeerConnection.prototype = OrigPeerConnection.prototype;
  // wrap static methods. Currently just generateCertificate.
  if ('generateCertificate' in window.RTCPeerConnection) {
    Object.defineProperty(window.RTCPeerConnection, 'generateCertificate', {
      get: function get() {
        return OrigPeerConnection.generateCertificate;
      }
    });
  }
}

function shimTrackEventTransceiver(window) {
  // Add event.transceiver member over deprecated event.receiver
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object' && window.RTCTrackEvent && 'receiver' in window.RTCTrackEvent.prototype && !('transceiver' in window.RTCTrackEvent.prototype)) {
    Object.defineProperty(window.RTCTrackEvent.prototype, 'transceiver', {
      get: function get() {
        return { receiver: this.receiver };
      }
    });
  }
}

function shimCreateOfferLegacy(window) {
  var origCreateOffer = window.RTCPeerConnection.prototype.createOffer;
  window.RTCPeerConnection.prototype.createOffer = function createOffer(offerOptions) {
    if (offerOptions) {
      if (typeof offerOptions.offerToReceiveAudio !== 'undefined') {
        // support bit values
        offerOptions.offerToReceiveAudio = !!offerOptions.offerToReceiveAudio;
      }
      var audioTransceiver = this.getTransceivers().find(function (transceiver) {
        return transceiver.receiver.track.kind === 'audio';
      });
      if (offerOptions.offerToReceiveAudio === false && audioTransceiver) {
        if (audioTransceiver.direction === 'sendrecv') {
          if (audioTransceiver.setDirection) {
            audioTransceiver.setDirection('sendonly');
          } else {
            audioTransceiver.direction = 'sendonly';
          }
        } else if (audioTransceiver.direction === 'recvonly') {
          if (audioTransceiver.setDirection) {
            audioTransceiver.setDirection('inactive');
          } else {
            audioTransceiver.direction = 'inactive';
          }
        }
      } else if (offerOptions.offerToReceiveAudio === true && !audioTransceiver) {
        this.addTransceiver('audio');
      }

      if (typeof offerOptions.offerToReceiveVideo !== 'undefined') {
        // support bit values
        offerOptions.offerToReceiveVideo = !!offerOptions.offerToReceiveVideo;
      }
      var videoTransceiver = this.getTransceivers().find(function (transceiver) {
        return transceiver.receiver.track.kind === 'video';
      });
      if (offerOptions.offerToReceiveVideo === false && videoTransceiver) {
        if (videoTransceiver.direction === 'sendrecv') {
          if (videoTransceiver.setDirection) {
            videoTransceiver.setDirection('sendonly');
          } else {
            videoTransceiver.direction = 'sendonly';
          }
        } else if (videoTransceiver.direction === 'recvonly') {
          if (videoTransceiver.setDirection) {
            videoTransceiver.setDirection('inactive');
          } else {
            videoTransceiver.direction = 'inactive';
          }
        }
      } else if (offerOptions.offerToReceiveVideo === true && !videoTransceiver) {
        this.addTransceiver('video');
      }
    }
    return origCreateOffer.apply(this, arguments);
  };
}

},{"../utils":99}],99:[function(require,module,exports){
/*
 *  Copyright (c) 2016 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */
'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.extractVersion = extractVersion;
exports.wrapPeerConnectionEvent = wrapPeerConnectionEvent;
exports.disableLog = disableLog;
exports.disableWarnings = disableWarnings;
exports.log = log;
exports.deprecated = deprecated;
exports.detectBrowser = detectBrowser;
exports.compactObject = compactObject;
exports.walkStats = walkStats;
exports.filterStats = filterStats;

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var logDisabled_ = true;
var deprecationWarnings_ = true;

/**
 * Extract browser version out of the provided user agent string.
 *
 * @param {!string} uastring userAgent string.
 * @param {!string} expr Regular expression used as match criteria.
 * @param {!number} pos position in the version string to be returned.
 * @return {!number} browser version.
 */
function extractVersion(uastring, expr, pos) {
  var match = uastring.match(expr);
  return match && match.length >= pos && parseInt(match[pos], 10);
}

// Wraps the peerconnection event eventNameToWrap in a function
// which returns the modified event object (or false to prevent
// the event).
function wrapPeerConnectionEvent(window, eventNameToWrap, wrapper) {
  if (!window.RTCPeerConnection) {
    return;
  }
  var proto = window.RTCPeerConnection.prototype;
  var nativeAddEventListener = proto.addEventListener;
  proto.addEventListener = function (nativeEventName, cb) {
    if (nativeEventName !== eventNameToWrap) {
      return nativeAddEventListener.apply(this, arguments);
    }
    var wrappedCallback = function wrappedCallback(e) {
      var modifiedEvent = wrapper(e);
      if (modifiedEvent) {
        cb(modifiedEvent);
      }
    };
    this._eventMap = this._eventMap || {};
    this._eventMap[cb] = wrappedCallback;
    return nativeAddEventListener.apply(this, [nativeEventName, wrappedCallback]);
  };

  var nativeRemoveEventListener = proto.removeEventListener;
  proto.removeEventListener = function (nativeEventName, cb) {
    if (nativeEventName !== eventNameToWrap || !this._eventMap || !this._eventMap[cb]) {
      return nativeRemoveEventListener.apply(this, arguments);
    }
    var unwrappedCb = this._eventMap[cb];
    delete this._eventMap[cb];
    return nativeRemoveEventListener.apply(this, [nativeEventName, unwrappedCb]);
  };

  Object.defineProperty(proto, 'on' + eventNameToWrap, {
    get: function get() {
      return this['_on' + eventNameToWrap];
    },
    set: function set(cb) {
      if (this['_on' + eventNameToWrap]) {
        this.removeEventListener(eventNameToWrap, this['_on' + eventNameToWrap]);
        delete this['_on' + eventNameToWrap];
      }
      if (cb) {
        this.addEventListener(eventNameToWrap, this['_on' + eventNameToWrap] = cb);
      }
    },

    enumerable: true,
    configurable: true
  });
}

function disableLog(bool) {
  if (typeof bool !== 'boolean') {
    return new Error('Argument type: ' + (typeof bool === 'undefined' ? 'undefined' : _typeof(bool)) + '. Please use a boolean.');
  }
  logDisabled_ = bool;
  return bool ? 'adapter.js logging disabled' : 'adapter.js logging enabled';
}

/**
 * Disable or enable deprecation warnings
 * @param {!boolean} bool set to true to disable warnings.
 */
function disableWarnings(bool) {
  if (typeof bool !== 'boolean') {
    return new Error('Argument type: ' + (typeof bool === 'undefined' ? 'undefined' : _typeof(bool)) + '. Please use a boolean.');
  }
  deprecationWarnings_ = !bool;
  return 'adapter.js deprecation warnings ' + (bool ? 'disabled' : 'enabled');
}

function log() {
  if ((typeof window === 'undefined' ? 'undefined' : _typeof(window)) === 'object') {
    if (logDisabled_) {
      return;
    }
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log.apply(console, arguments);
    }
  }
}

/**
 * Shows a deprecation warning suggesting the modern and spec-compatible API.
 */
function deprecated(oldMethod, newMethod) {
  if (!deprecationWarnings_) {
    return;
  }
  console.warn(oldMethod + ' is deprecated, please use ' + newMethod + ' instead.');
}

/**
 * Browser detector.
 *
 * @return {object} result containing browser and version
 *     properties.
 */
function detectBrowser(window) {
  var navigator = window.navigator;

  // Returned result object.

  var result = { browser: null, version: null };

  // Fail early if it's not a browser
  if (typeof window === 'undefined' || !window.navigator) {
    result.browser = 'Not a browser.';
    return result;
  }

  if (navigator.mozGetUserMedia) {
    // Firefox.
    result.browser = 'firefox';
    result.version = extractVersion(navigator.userAgent, /Firefox\/(\d+)\./, 1);
  } else if (navigator.webkitGetUserMedia || window.isSecureContext === false && window.webkitRTCPeerConnection && !window.RTCIceGatherer) {
    // Chrome, Chromium, Webview, Opera.
    // Version matches Chrome/WebRTC version.
    // Chrome 74 removed webkitGetUserMedia on http as well so we need the
    // more complicated fallback to webkitRTCPeerConnection.
    result.browser = 'chrome';
    result.version = extractVersion(navigator.userAgent, /Chrom(e|ium)\/(\d+)\./, 2);
  } else if (navigator.mediaDevices && navigator.userAgent.match(/Edge\/(\d+).(\d+)$/)) {
    // Edge.
    result.browser = 'edge';
    result.version = extractVersion(navigator.userAgent, /Edge\/(\d+).(\d+)$/, 2);
  } else if (window.RTCPeerConnection && navigator.userAgent.match(/AppleWebKit\/(\d+)\./)) {
    // Safari.
    result.browser = 'safari';
    result.version = extractVersion(navigator.userAgent, /AppleWebKit\/(\d+)\./, 1);
    result.supportsUnifiedPlan = window.RTCRtpTransceiver && 'currentDirection' in window.RTCRtpTransceiver.prototype;
  } else {
    // Default fallthrough: not supported.
    result.browser = 'Not a supported browser.';
    return result;
  }

  return result;
}

/**
 * Checks if something is an object.
 *
 * @param {*} val The something you want to check.
 * @return true if val is an object, false otherwise.
 */
function isObject(val) {
  return Object.prototype.toString.call(val) === '[object Object]';
}

/**
 * Remove all empty objects and undefined values
 * from a nested object -- an enhanced and vanilla version
 * of Lodash's `compact`.
 */
function compactObject(data) {
  if (!isObject(data)) {
    return data;
  }

  return Object.keys(data).reduce(function (accumulator, key) {
    var isObj = isObject(data[key]);
    var value = isObj ? compactObject(data[key]) : data[key];
    var isEmptyObject = isObj && !Object.keys(value).length;
    if (value === undefined || isEmptyObject) {
      return accumulator;
    }
    return Object.assign(accumulator, _defineProperty({}, key, value));
  }, {});
}

/* iterates the stats graph recursively. */
function walkStats(stats, base, resultSet) {
  if (!base || resultSet.has(base.id)) {
    return;
  }
  resultSet.set(base.id, base);
  Object.keys(base).forEach(function (name) {
    if (name.endsWith('Id')) {
      walkStats(stats, stats.get(base[name]), resultSet);
    } else if (name.endsWith('Ids')) {
      base[name].forEach(function (id) {
        walkStats(stats, stats.get(id), resultSet);
      });
    }
  });
}

/* filter getStats for a sender/receiver track. */
function filterStats(result, track, outbound) {
  var streamStatsType = outbound ? 'outbound-rtp' : 'inbound-rtp';
  var filteredResult = new Map();
  if (track === null) {
    return filteredResult;
  }
  var trackStats = [];
  result.forEach(function (value) {
    if (value.type === 'track' && value.trackIdentifier === track.id) {
      trackStats.push(value);
    }
  });
  trackStats.forEach(function (trackStat) {
    result.forEach(function (stats) {
      if (stats.type === streamStatsType && stats.trackId === trackStat.id) {
        walkStats(result, stats, filteredResult);
      }
    });
  });
  return filteredResult;
}

},{}],100:[function(require,module,exports){
/*
WildEmitter.js is a slim little event emitter by @henrikjoreteg largely based
on @visionmedia's Emitter from UI Kit.

Why? I wanted it standalone.

I also wanted support for wildcard emitters like this:

emitter.on('*', function (eventName, other, event, payloads) {

});

emitter.on('somenamespace*', function (eventName, payloads) {

});

Please note that callbacks triggered by wildcard registered events also get
the event name as the first argument.
*/

module.exports = WildEmitter;

function WildEmitter() { }

WildEmitter.mixin = function (constructor) {
    var prototype = constructor.prototype || constructor;

    prototype.isWildEmitter= true;

    // Listen on the given `event` with `fn`. Store a group name if present.
    prototype.on = function (event, groupName, fn) {
        this.callbacks = this.callbacks || {};
        var hasGroup = (arguments.length === 3),
            group = hasGroup ? arguments[1] : undefined,
            func = hasGroup ? arguments[2] : arguments[1];
        func._groupName = group;
        (this.callbacks[event] = this.callbacks[event] || []).push(func);
        return this;
    };

    // Adds an `event` listener that will be invoked a single
    // time then automatically removed.
    prototype.once = function (event, groupName, fn) {
        var self = this,
            hasGroup = (arguments.length === 3),
            group = hasGroup ? arguments[1] : undefined,
            func = hasGroup ? arguments[2] : arguments[1];
        function on() {
            self.off(event, on);
            func.apply(this, arguments);
        }
        this.on(event, group, on);
        return this;
    };

    // Unbinds an entire group
    prototype.releaseGroup = function (groupName) {
        this.callbacks = this.callbacks || {};
        var item, i, len, handlers;
        for (item in this.callbacks) {
            handlers = this.callbacks[item];
            for (i = 0, len = handlers.length; i < len; i++) {
                if (handlers[i]._groupName === groupName) {
                    //console.log('removing');
                    // remove it and shorten the array we're looping through
                    handlers.splice(i, 1);
                    i--;
                    len--;
                }
            }
        }
        return this;
    };

    // Remove the given callback for `event` or all
    // registered callbacks.
    prototype.off = function (event, fn) {
        this.callbacks = this.callbacks || {};
        var callbacks = this.callbacks[event],
            i;

        if (!callbacks) return this;

        // remove all handlers
        if (arguments.length === 1) {
            delete this.callbacks[event];
            return this;
        }

        // remove specific handler
        i = callbacks.indexOf(fn);
        callbacks.splice(i, 1);
        if (callbacks.length === 0) {
            delete this.callbacks[event];
        }
        return this;
    };

    /// Emit `event` with the given args.
    // also calls any `*` handlers
    prototype.emit = function (event) {
        this.callbacks = this.callbacks || {};
        var args = [].slice.call(arguments, 1),
            callbacks = this.callbacks[event],
            specialCallbacks = this.getWildcardCallbacks(event),
            i,
            len,
            item,
            listeners;

        if (callbacks) {
            listeners = callbacks.slice();
            for (i = 0, len = listeners.length; i < len; ++i) {
                if (!listeners[i]) {
                    break;
                }
                listeners[i].apply(this, args);
            }
        }

        if (specialCallbacks) {
            len = specialCallbacks.length;
            listeners = specialCallbacks.slice();
            for (i = 0, len = listeners.length; i < len; ++i) {
                if (!listeners[i]) {
                    break;
                }
                listeners[i].apply(this, [event].concat(args));
            }
        }

        return this;
    };

    // Helper for for finding special wildcard event handlers that match the event
    prototype.getWildcardCallbacks = function (eventName) {
        this.callbacks = this.callbacks || {};
        var item,
            split,
            result = [];

        for (item in this.callbacks) {
            split = item.split('*');
            if (item === '*' || (split.length === 2 && eventName.slice(0, split[0].length) === split[0])) {
                result = result.concat(this.callbacks[item]);
            }
        }
        return result;
    };

};

WildEmitter.mixin(WildEmitter);

},{}],101:[function(require,module,exports){
'use strict';

var alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'.split('')
  , length = 64
  , map = {}
  , seed = 0
  , i = 0
  , prev;

/**
 * Return a string representing the specified number.
 *
 * @param {Number} num The number to convert.
 * @returns {String} The string representation of the number.
 * @api public
 */
function encode(num) {
  var encoded = '';

  do {
    encoded = alphabet[num % length] + encoded;
    num = Math.floor(num / length);
  } while (num > 0);

  return encoded;
}

/**
 * Return the integer value specified by the given string.
 *
 * @param {String} str The string to convert.
 * @returns {Number} The integer value represented by the string.
 * @api public
 */
function decode(str) {
  var decoded = 0;

  for (i = 0; i < str.length; i++) {
    decoded = decoded * length + map[str.charAt(i)];
  }

  return decoded;
}

/**
 * Yeast: A tiny growing id generator.
 *
 * @returns {String} A unique id.
 * @api public
 */
function yeast() {
  var now = encode(+new Date());

  if (now !== prev) return seed = 0, prev = now;
  return now +'.'+ encode(seed++);
}

//
// Map each character to its index.
//
for (; i < length; i++) map[alphabet[i]] = i;

//
// Expose the `yeast`, `encode` and `decode` functions.
//
yeast.encode = encode;
yeast.decode = decode;
module.exports = yeast;

},{}]},{},[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,24,26,27,28]);
