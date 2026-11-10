/**
 * Zero-dependency .env loader for Node.js 12+.
 * Loads environment variables from .env file into process.env.
 */

'use strict';

var fs = require('fs');
var path = require('path');

function loadEnv(customPath) {
  var candidates = [
    customPath,
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../.env')
  ];

  for (var i = 0; i < candidates.length; i++) {
    var filePath = candidates[i];
    if (filePath && fs.existsSync(filePath)) {
      try {
        var content = fs.readFileSync(filePath, 'utf8');
        var lines = content.split('\n');
        for (var j = 0; j < lines.length; j++) {
          var line = lines[j].trim();
          if (!line || line.indexOf('#') === 0) continue;
          var eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            var key = line.slice(0, eqIdx).trim();
            var val = line.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      } catch (err) {
        // Silently continue
      }
    }
  }

  // Normalize aliases for Google credentials
  if (process.env.G_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID) {
    process.env.GOOGLE_CLIENT_ID = process.env.G_CLIENT_ID;
  }
  if (process.env.G_CLIENT_SECRET && !process.env.GOOGLE_CLIENT_SECRET) {
    process.env.GOOGLE_CLIENT_SECRET = process.env.G_CLIENT_SECRET;
  }
  if (process.env.GOOGLE_CLIENT_ID && !process.env.G_CLIENT_ID) {
    process.env.G_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  }
  if (process.env.GOOGLE_CLIENT_SECRET && !process.env.G_CLIENT_SECRET) {
    process.env.G_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  }
}

// Automatically load on require
loadEnv();

module.exports = {
  loadEnv: loadEnv
};

