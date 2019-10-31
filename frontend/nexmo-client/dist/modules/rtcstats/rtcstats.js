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
