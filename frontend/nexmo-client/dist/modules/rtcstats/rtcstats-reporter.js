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
