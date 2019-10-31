# Nexmo WeChat integration

To set the demo you will need to:

1. Fill the relevant fields in example.env file:
   1. NEXMO_API_KEY- Your Nexmo account's key
   2. NEXMO_API_SECRET- Your Nexmo account's secret
   3. NEXMO_APP_ID- The Nexmo application ID you would like to use
   4. NEXMO_APP_NAME- The name of the above application
   5. NEXMO_CONVERSATION_ID- The default conversation within your application
   6. NEXMO_PRIVATE_KEY- The path to your Nexmo private key
   7. WECHAT_APP_ID- The WeChat application ID you would like to use
   8. WECHAT_APP_SECRET- The WeChat secret
   9. SERVER_ADDRESS- Your server's external address, for webhook registration
2. copy the example.env file to .env:
   cp example.env .env
