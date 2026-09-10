import test from 'node:test';
import assert from 'node:assert/strict';
import {getMemberIdentity} from '../server/identity.mjs';
import {billingFailure, requireMember} from '../server/plan.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const session = {id, email: 'member@example.test'};
const confirmed = {...session, confirmedAt: '2026-09-10T00:00:00Z'};
const unexpected = async () => { throw new Error('Unexpected Identity admin request'); };

test('SDK claims-only session is completed from its own Identity record', async () => {
  const requested = [];
  const member = await getMemberIdentity({getUser: async () => session, admin: {getUser: async userId => {
    requested.push(userId); return confirmed;
  }}});
  assert.deepEqual(requested, [id]);
  assert.deepEqual(requireMember(member), session);
});

test('full verified SDK profile works without an operator token or another lookup', async () => {
  assert.equal(await getMemberIdentity({getUser: async () => confirmed, admin: {getUser: unexpected}}), confirmed);
});

test('signed-out and malformed sessions never trigger a privileged lookup', async () => {
  assert.equal(await getMemberIdentity({getUser: async () => null, admin: {getUser: unexpected}}), null);
  for (const value of [{}, {id, email: ''}, {id: [], email: 'member@example.test'}])
    await assert.rejects(getMemberIdentity({getUser: async () => value, admin: {getUser: unexpected}}),
      error => error.status === 401 && error.code === 'login_required');
});

test('a different user returned by Identity is rejected', async () => {
  await assert.rejects(getMemberIdentity({getUser: async () => session,
    admin: {getUser: async () => ({...confirmed, id: '00000000-0000-4000-8000-000000000002'})}}),
  error => error.status === 401 && error.code === 'identity_mismatch');
});

test('unconfirmed, malformed, and user-metadata-forged records remain rejected', async () => {
  for (const confirmedAt of [undefined, null, '', 'invalid-date', true, 0]) {
    const profile = {...session, confirmedAt, emailVerified: true,
      userMetadata: {confirmedAt: confirmed.confirmedAt, emailVerified: true}};
    await assert.rejects(getMemberIdentity({getUser: async () => ({...session,
      userMetadata: {id: 'another-user', confirmedAt: confirmed.confirmedAt}}),
      admin: {getUser: async userId => { assert.equal(userId, id); return profile; }}}),
    error => error.status === 401 && error.code === 'email_confirmation_required');
  }
});

test('provider outage denies access without exposing its error or credentials', async () => {
  for (const status of [undefined, 401, 403, 500]) {
    const upstream = Object.assign(new Error('private-provider-response'), {status});
    try {
      await getMemberIdentity({getUser: async () => session, admin: {getUser: async () => { throw upstream; }}});
      assert.fail('Outage must deny access');
    } catch (error) {
      const response = billingFailure(error);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'identity_unavailable');
      assert.ok(!JSON.stringify(body).includes(upstream.message));
    }
  }
});

test('deleted Identity user is treated as signed out', async () => {
  await assert.rejects(getMemberIdentity({getUser: async () => session,
    admin: {getUser: async () => { throw Object.assign(new Error('deleted'), {status: 404}); }}}),
  error => error.status === 401 && error.code === 'login_required');
});
