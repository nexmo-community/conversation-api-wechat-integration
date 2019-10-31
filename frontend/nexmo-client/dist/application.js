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
