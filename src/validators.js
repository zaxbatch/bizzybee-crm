'use strict';

const { DEAL_STAGES } = require('./db');

const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'];
const CONTACT_STATUSES = ['lead', 'prospect', 'customer', 'inactive'];

function str(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return `${field} is required`;
    return null;
  }
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.trim().length > max) return `${field} must be ${max} characters or fewer`;
  return null;
}

function email(value) {
  if (!value) return 'email is required';
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    return 'email must be a valid email address';
  }
  return null;
}

function oneOf(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!allowed.includes(value)) return `${field} must be one of: ${allowed.join(', ')}`;
  return null;
}

function num(value, field, { min = 0, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return `${field} is required`;
    return null;
  }
  const n = Number(value);
  if (Number.isNaN(n)) return `${field} must be a number`;
  if (n < min) return `${field} must be at least ${min}`;
  return null;
}

function isoDate(value, field, { required = false } = {}) {
  if (!value || value === '') {
    if (required) return `${field} is required`;
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field} must be a valid ISO date`;
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return null;
}

function validateContact(body, { partial = false } = {}) {
  const errors = [];
  const push = (err) => { if (err) errors.push(err); };
  push(str(body.firstName, 'firstName', { required: !partial }));
  push(str(body.lastName, 'lastName', { required: !partial }));
  if (!partial) {
    push(email(body.email));
  } else if (body.email) {
    push(email(body.email));
  }
  push(str(body.phone, 'phone'));
  push(str(body.title, 'title'));
  push(str(body.address, 'address'));
  push(oneOf(body.status, CONTACT_STATUSES, 'status'));
  push(str(body.companyId, 'companyId'));
  push(str(body.notes, 'notes', { max: 2000 }));
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      errors.push('tags must be an array of strings');
    }
  }
  return errors;
}

function validateCompany(body, { partial = false } = {}) {
  const errors = [];
  const push = (err) => { if (err) errors.push(err); };
  push(str(body.name, 'name', { required: !partial }));
  push(str(body.industry, 'industry'));
  push(str(body.website, 'website'));
  push(str(body.address, 'address'));
  push(str(body.size, 'size'));
  push(str(body.notes, 'notes', { max: 2000 }));
  return errors;
}

function validateDeal(body, { partial = false } = {}) {
  const errors = [];
  const push = (err) => { if (err) errors.push(err); };
  push(str(body.title, 'title', { required: !partial }));
  push(num(body.amount, 'amount', { min: 0, required: !partial }));
  push(oneOf(body.stage, DEAL_STAGES, 'stage'));
  push(str(body.contactId, 'contactId'));
  push(str(body.companyId, 'companyId'));
  push(isoDate(body.expectedClose, 'expectedClose'));
  push(str(body.notes, 'notes', { max: 2000 }));
  return errors;
}

function validateActivity(body, { partial = false } = {}) {
  const errors = [];
  const push = (err) => { if (err) errors.push(err); };
  push(oneOf(body.type, ACTIVITY_TYPES, 'type'));
  push(str(body.subject, 'subject', { required: !partial }));
  push(str(body.body, 'body', { max: 5000 }));
  push(str(body.contactId, 'contactId')); // contact is optional
  push(isoDate(body.happenedAt, 'happenedAt'));
  return errors;
}

module.exports = { validateContact, validateCompany, validateDeal, validateActivity, validatePassword, ACTIVITY_TYPES, CONTACT_STATUSES };
