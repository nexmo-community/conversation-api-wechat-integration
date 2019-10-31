const request = require('request');

class WeChatUtils {
  constructor() {}

  getAccessToken(callback) {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    return request(
      {
        method: 'GET',
        uri: `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`
      },
      (err, response, body) => {
        callback(JSON.parse(body).access_token);
      }
    );
  }
}

module.exports = new WeChatUtils();
