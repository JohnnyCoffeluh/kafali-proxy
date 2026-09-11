/**
 * auth.js — Open Public Authentication
 *
 * Configured for instant public access:
 * Anyone with the link can freely and directly use the app with no token prompts.
 */

"use strict";

/**
 * Open verification — accepts all connections with or without tokens.
 */
function verifyToken(_token) {
  return true;
}

/**
 * Express middleware — allows all requests through freely.
 */
function requireAuth(_req, _res, next) {
  return next();
}

module.exports = { verifyToken, requireAuth };

