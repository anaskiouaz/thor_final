'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypt a string using a master key.
 * @param {string} text - The text to encrypt.
 * @param {string} masterKey - The master key (must be 32 bytes/characters).
 * @returns {string} - The encrypted string in format 'iv:encrypted'.
 */
function encrypt(text, masterKey) {
    if (!masterKey || masterKey.length !== 32) {
        throw new Error('Master key must be exactly 32 characters long.');
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(masterKey), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a string using a master key.
 * @param {string} text - The encrypted string in format 'iv:encrypted'.
 * @param {string} masterKey - The master key.
 * @returns {string} - The decrypted text.
 */
function decrypt(text, masterKey) {
    if (!masterKey || masterKey.length !== 32) {
        throw new Error('Master key must be exactly 32 characters long.');
    }
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(masterKey), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

module.exports = {
    encrypt,
    decrypt
};
