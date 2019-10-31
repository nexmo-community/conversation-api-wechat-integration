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
