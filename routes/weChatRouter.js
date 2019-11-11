const express = require('express');
const router = express.Router();
const request = require('request');
const Nexmo = require('nexmo');
const WeChatMessageEvent = require('../module/wechatevent');
const weChatUtils = require('../module/wechatutils');

const nexmo = new Nexmo({
  apiKey: process.env.NEXMO_API_KEY,
  apiSecret: process.env.NEXMO_API_SECRET,
  applicationId: process.env.NEXMO_APP_ID,
  privateKey: process.env.NEXMO_PRIVATE_KEY
});

const jwt = nexmo.generateJwt({
  acl: {
    paths: {
      '/*/users/**': {},
      '/*/conversations/**': {},
      '/*/sessions/**': {},
      '/*/devices/**': {},
      '/*/image/**': {},
      '/*/media/**': {},
      '/*/applications/**': {},
      '/*/push/**': {},
      '/*/knocking/**': {}
    }
  },
  exp: 1572352778888
});

var asdate = new Date();

// add a day
asdate.setDate(asdate.getDate() + 1);

const conversationId = process.env.NEXMO_CONVERSATION_ID;

/**
 * Sending WeChat inbound message to Conversation API
 * @param {*} to - MEMBER ID
 * @param {*} from - WeChat ID from sender
 * @param {*} direction - `inbound`
 * @param {*} content - Content for the message
 */
const dispatchWeChatEvent = (wechat, direction = 'inbound') => {
  const params = {
    type: 'custom:wechat:message',
    body: {
      to: wechat.getTo(),
      from: wechat.getFrom(),
      content: wechat.getContent(),
      direction
    }
  };

  nexmo.conversations.events.create(conversationId, params, (err, data) => {
    if (!err) {
      console.log('successfuly sent message to: ' + params.body.to + ', with message: ' + params.body.content);
    }
  });
};

/**
 * This route will be called by WeChat webhook registration process.
 * Basically, you need to make sure that the request is coming from WeChat.
 * For this simplicity use case, we just return back the `echostr` variable directly.
 */
router.get('/', (req, res) => {
  const { echostr } = req.query;
  res
    .status(200)
    .send(echostr)
    .end();
});

/**
 * This route will be called by WeChat webhook when a new message come.
 * WeChat will send a XML body, you can use `body-parser` to parse the XML.
 */
router.post('/', async function(req, res, next) {
  const { xml } = req.body;

  await weChatUtils.getAccessToken(token => {
    const from = xml.fromusername;
    request(
      {
        method: 'GET',
        url: `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${from}`,
        headers: { 'Content-Type': 'application/json' }
      },
      (err, response, body) => {
        const weChatMessage = new WeChatMessageEvent(xml.tousername, JSON.parse(body).nickname, xml.content);
        const direction = 'inbound';

        console.log(`Received ${direction} message from: ${weChatMessage.getFrom()} to: ${weChatMessage.getTo()} with content: ${weChatMessage.getContent()}`);
        dispatchWeChatEvent(weChatMessage, direction);
      }
    );
  });

  res.status(200).end();
});

dispatchWeChatEvent(new WeChatMessageEvent('Roy', 'Test', 'Test'));

module.exports = router;
