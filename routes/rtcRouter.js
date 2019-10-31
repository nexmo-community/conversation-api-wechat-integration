const express = require('express');
const router = express.Router();
const request = require('request');
const base64 = require('base-64');
const WeChatMessageEvent = require('../module/wechatevent');
const weChatUtils = require('../module/wechatutils');

const registerToRTCCallbacks = () => {
  const path = process.env.SERVER_ADDRESS + '/rtcEvent';
  const appId = process.env.NEXMO_APP_ID;
  const appName = process.env.NEXMO_APP_NAME;
  const b64ApiKeyApiPass = base64.encode(process.env.NEXMO_API_KEY + ':' + process.env.NEXMO_API_SECRET);
  request(
    {
      method: 'PUT',
      uri: `https://api.nexmo.com/v2/applications/${appId}`,
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + b64ApiKeyApiPass },
      body: JSON.stringify({
        name: appName,
        capabilities: {
          rtc: {
            webhooks: {
              event_url: {
                address: path,
                http_method: 'POST'
              }
            }
          }
        }
      })
    },
    (err, response, body) => {
      console.log('RTC registration process: ' + body);
    }
  );
};

/**
 * Sending an outbound message to WeChat API.
 * To send a message, you need to provide `access_token` to the endpoint.
 * @param {*} to - WeChat ID
 * @param {*} from - Member ID
 * @param {*} content - Content of the message
 */
const sendWeChatMessage = (token, wechat) => {
  request(
    {
      method: 'POST',
      url: `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: wechat.getTo(),
        msgtype: 'text',
        text: { content: wechat.getContent() }
      })
    },
    (err, response, body) => {
      console.log('Sent WeChat message: ' + body);
    }
  );
};

router.post('/', async function(req, res, next) {
  await weChatUtils.getAccessToken(token => {
    if (req.body.type === 'custom:wechat:message' && req.body.body.direction === 'outbound') {
      const to = req.body.body.to;
      const from = req.body.body.from;
      const content = req.body.body.content;
      const wechat = new WeChatMessageEvent(to, from, content);

      sendWeChatMessage(token, wechat);
    }
  });
  res.sendStatus(200);
});

registerToRTCCallbacks();

module.exports = router;
