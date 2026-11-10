/**
 * Google OAuth 2.0 and Authentication Manager for RemindMe Web App.
 * Compatible with Node.js 12+.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var querystring = require('querystring');
require('../utils/env-loader');
var httpClient = require('../utils/http-client');

var SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

var AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
var TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
var USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

var GoogleAuth = function (appConfigRepo) {
  this.configRepo = appConfigRepo;
};

GoogleAuth.prototype.getClientCredentials = async function () {
  // 1. Check environment variables (.env takes priority)
  var envId = process.env.G_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.REMINDME_GOOGLE_CLIENT_ID || process.env.CLIENT_ID;
  var envSecret = process.env.G_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.REMINDME_GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET;
  if (envId && envSecret && envId.trim() && envSecret.trim()) {
    return {
      clientId: envId.trim(),
      clientSecret: envSecret.trim(),
      source: 'environment'
    };
  }

  // 2. Check database app_config
  if (this.configRepo) {
    var dbId = await this.configRepo.get('google_client_id');
    var dbSecret = await this.configRepo.get('google_client_secret');
      if (dbId && dbSecret && dbId.indexOf('test-client') === -1) {
        return {
          clientId: dbId.trim(),
          clientSecret: dbSecret.trim(),
          source: 'database'
        };
      }
    }

    // 3. Check files
    var homeDir = os.homedir();
    var candidates = [
      path.resolve(__dirname, '../../data/google/client_secret.json'),
      path.resolve(homeDir, '.reminder-app/google/client_secret.json'),
      path.resolve(homeDir, '.reminder-app/google/credentials.json'),
      path.resolve(__dirname, '../../../integrations/google/client_secret.json')
    ];

    for (var i = 0; i < candidates.length; i++) {
      var filePath = candidates[i];
      if (fs.existsSync(filePath)) {
        try {
          var raw = fs.readFileSync(filePath, 'utf8');
          var parsed = JSON.parse(raw);
          var data = parsed.web || parsed.installed || parsed;
            if (data.client_id && data.client_secret && data.client_id.indexOf('test-client') === -1) {
              return {
                clientId: data.client_id.trim(),
                clientSecret: data.client_secret.trim(),
                source: 'file',
                path: filePath
              };
            }
          } catch (e) { }
        }
  }

      return null;
    };

    GoogleAuth.prototype.hasCredentials = async function () {
      var creds = await this.getClientCredentials();
      return Boolean(creds && creds.clientId && creds.clientSecret);
    };

    GoogleAuth.prototype.saveCredentials = async function (clientId, clientSecret, redirectUri) {
      if (!clientId || !clientSecret) {
        throw new Error('Client ID and Client Secret are required');
      }
      clientId = clientId.trim();
      clientSecret = clientSecret.trim();

      if (this.configRepo) {
        await this.configRepo.set('google_client_id', clientId);
        await this.configRepo.set('google_client_secret', clientSecret);
        if (redirectUri && redirectUri.trim()) {
          await this.configRepo.set('google_redirect_uri', redirectUri.trim());
        }
      }

      // Also save to data/google/client_secret.json for portability
      var dataDir = path.resolve(__dirname, '../../data/google');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      var jsonFile = path.resolve(dataDir, 'client_secret.json');
      var clientObj = {
        web: {
          client_id: clientId,
          client_secret: clientSecret,
          auth_uri: AUTH_ENDPOINT,
          token_uri: TOKEN_ENDPOINT
        }
      };
      fs.writeFileSync(jsonFile, JSON.stringify(clientObj, null, 2), 'utf8');

      return { saved: true, path: jsonFile };
    };

    GoogleAuth.prototype.createAuthUrl = async function (redirectUri, state) {
      var creds = await this.getClientCredentials();
      if (!creds) {
        throw new Error('Google Client credentials not configured. Please add Client ID & Secret in .env or Setup Guide.');
      }

      var params = {
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: state || 'remindme'
      };

      return AUTH_ENDPOINT + '?' + querystring.stringify(params);
    };

    GoogleAuth.prototype.exchangeCode = async function (code, redirectUri) {
      var creds = await this.getClientCredentials();
      if (!creds) {
        throw new Error('Google Client credentials not configured');
      }

      var form = {
        code: code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      };

      var data = await httpClient.postForm(TOKEN_ENDPOINT, form);
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        idToken: data.id_token,
        scope: data.scope,
        tokenType: data.token_type
      };
    };

    GoogleAuth.prototype.getUserInfo = async function (accessToken) {
      return await httpClient.getJson(USERINFO_ENDPOINT, {
        Authorization: 'Bearer ' + accessToken
      });
    };

    GoogleAuth.prototype.refreshAccessToken = async function (refreshToken) {
      var creds = await this.getClientCredentials();
      if (!creds) {
        throw new Error('Google Client credentials not configured');
      }

      var form = {
        refresh_token: refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'refresh_token'
      };

      var data = await httpClient.postForm(TOKEN_ENDPOINT, form);
      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
        scope: data.scope,
        tokenType: data.token_type
      };
    };

    GoogleAuth.prototype.getSetupGuide = function (redirectUri) {
      var baseUris = [
        redirectUri,
        'http://localhost:3000/api/google/oauth/callback',
        'http://127.0.0.1:3000/api/google/oauth/callback',
        'http://127.0.0.1:8765/api/google/oauth/callback'
      ];
      var recommendedUris = [];
      for (var u = 0; u < baseUris.length; u++) {
        if (recommendedUris.indexOf(baseUris[u]) === -1) {
          recommendedUris.push(baseUris[u]);
        }
      }

      return {
        redirect_uri: redirectUri,
        recommended_uris: recommendedUris,
        steps: [
          {
            num: 1,
            title: 'Open Google Cloud Console',
            url: 'https://console.cloud.google.com/projectcreate',
            desc: 'Go to console.cloud.google.com and create a project (e.g. "RemindMe Web") or select your existing project.',
            detail: 'Go to console.cloud.google.com and create a project (e.g. "RemindMe Web") or select your existing project.'
          },
          {
            num: 2,
            title: 'Enable Calendar, Tasks & Drive APIs',
            url: 'https://console.cloud.google.com/apis/library',
            desc: 'In APIs & Services > Library, enable "Google Calendar API", "Google Tasks API", and "Google Drive API".',
            detail: 'In APIs & Services > Library, enable "Google Calendar API", "Google Tasks API", and "Google Drive API".'
          },
          {
            num: 3,
            title: 'Configure OAuth Consent Screen',
            url: 'https://console.cloud.google.com/apis/credentials/consent',
            desc: 'Select "External", fill in App name ("RemindMe"), add your email under Test Users, and save.',
            detail: 'Select "External", fill in App name ("RemindMe"), add your email under Test Users, and save.'
          },
          {
            num: 4,
            title: 'Create or Edit OAuth Client ID',
            url: 'https://console.cloud.google.com/apis/credentials',
            desc: 'Go to Credentials > Create Credentials > OAuth client ID (Web application) or click your existing OAuth Client.',
            detail: 'Go to Credentials > Create Credentials > OAuth client ID (Web application) or click your existing OAuth Client.'
          },
          {
            num: 5,
            title: 'Add Authorized Redirect URIs',
            desc: 'Under "Authorized redirect URIs", paste: ' + redirectUri,
            detail: 'IMPORTANT: Google strictly checks this URL. To avoid "Error 400: redirect_uri_mismatch", make sure your current URL is added. When deploying online, add your production domain URL (e.g. https://your-domain.com/api/google/oauth/callback).'
          },
          {
            num: 6,
            title: 'Paste Credentials Below',
            desc: 'Copy Client ID and Client Secret, paste them below, and click "Save credentials". Then click Sign in with Google!',
            detail: 'Copy Client ID and Client Secret, paste them below, and click "Save credentials". Then click Sign in with Google!'
          }
        ]
      };
    };

    module.exports = GoogleAuth;
