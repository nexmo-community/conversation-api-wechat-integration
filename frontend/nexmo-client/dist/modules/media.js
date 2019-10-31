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
