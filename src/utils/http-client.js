/**
 * Lightweight HTTP/HTTPS request client for Node.js 12+.
 * Zero external dependencies.
 */

'use strict';

var http = require('http');
var https = require('https');
var url = require('url');
var querystring = require('querystring');

function request(options, postData) {
  return new Promise(function(resolve, reject) {
    var parsedUrl;
    if (typeof options === 'string') {
      parsedUrl = url.parse(options);
      options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'GET'
      };
    } else if (options.url) {
      parsedUrl = url.parse(options.url);
      options.protocol = parsedUrl.protocol;
      options.hostname = parsedUrl.hostname;
      options.port = parsedUrl.port;
      options.path = parsedUrl.path;
    }

    var protocol = options.protocol === 'http:' ? http : https;
    options.headers = options.headers || {};

    if (postData) {
      var dataStr = typeof postData === 'string' ? postData : Buffer.isBuffer(postData) ? postData : JSON.stringify(postData);
      if (!options.headers['Content-Length']) {
        options.headers['Content-Length'] = Buffer.byteLength(dataStr);
      }
    }

    var req = protocol.request(options, function(res) {
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });
      res.on('end', function() {
        var bodyBuffer = Buffer.concat(chunks);
        var bodyText = bodyBuffer.toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: bodyText,
          buffer: bodyBuffer
        });
      });
    });

    req.on('error', function(err) {
      reject(err);
    });

    req.setTimeout(options.timeout || 30000, function() {
      req.abort();
      reject(new Error('Request timed out'));
    });

    if (postData) {
      var dataToSend = typeof postData === 'string' ? postData : Buffer.isBuffer(postData) ? postData : JSON.stringify(postData);
      req.write(dataToSend);
    }
    req.end();
  });
}

async function getJson(targetUrl, headers) {
  var res = await request({
    url: targetUrl,
    method: 'GET',
    headers: Object.assign({ Accept: 'application/json' }, headers || {})
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  return JSON.parse(res.body);
}

async function postJson(targetUrl, body, headers) {
  var res = await request(
    {
      url: targetUrl,
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        headers || {}
      )
    },
    body
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  return JSON.parse(res.body);
}

async function postForm(targetUrl, formData, headers) {
  var dataStr = querystring.stringify(formData);
  var res = await request(
    {
      url: targetUrl,
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        headers || {}
      )
    },
    dataStr
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  return JSON.parse(res.body);
}

async function getText(targetUrl, headers) {
  var res = await request({
    url: targetUrl,
    method: 'GET',
    headers: Object.assign({}, headers || {})
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  return res.body;
}

async function putJson(targetUrl, body, headers) {
  var res = await request(
    {
      url: targetUrl,
      method: 'PUT',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        headers || {}
      )
    },
    body
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  if (res.statusCode === 204 || !res.body || !res.body.trim()) {
    return { success: true };
  }
  return JSON.parse(res.body);
}

async function patchJson(targetUrl, body, headers) {
  var res = await request(
    {
      url: targetUrl,
      method: 'PATCH',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        headers || {}
      )
    },
    body
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  if (res.statusCode === 204 || !res.body || !res.body.trim()) {
    return { success: true };
  }
  return JSON.parse(res.body);
}

async function deleteJson(targetUrl, headers) {
  var res = await request({
    url: targetUrl,
    method: 'DELETE',
    headers: Object.assign({ Accept: 'application/json' }, headers || {})
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 300));
  }
  if (res.statusCode === 204 || !res.body || !res.body.trim()) {
    return { deleted: true };
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return { deleted: true };
  }
}

module.exports = {
  request: request,
  getJson: getJson,
  postJson: postJson,
  postForm: postForm,
  putJson: putJson,
  patchJson: patchJson,
  deleteJson: deleteJson,
  getText: getText
};

