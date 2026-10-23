/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import { buildBody } from '../lib/service/reporters/webhook.js';

/** Alert payload whose message needs JSON escaping and contains `$` patterns. */
const payload = {
  log_level: 'error',
  log: 'said "hi"\nthen $& and $1',
  process_name: 'api',
  time: '2026-01-01T00:00:00.000Z',
};

describe('webhook buildBody', () => {
  it('escapes a variable placed inside a JSON string', () => {
    const body = buildBody([{ key: 'payload', value: '{"msg": "[{logLevel}] {log_message}"}' }], payload);
    expect(body.payload).to.deep.equal({ msg: '[error] said "hi"\nthen $& and $1' });
  });

  it('quotes a variable placed outside a JSON string', () => {
    const body = buildBody([{ key: 'payload', value: '{"msg": {log_message}, "app": {process_name}}' }], payload);
    expect(body.payload).to.deep.equal({ msg: payload.log, app: 'api' });
  });

  it('turns a bare variable into a string', () => {
    const body = buildBody([{ key: 'text', value: '{log_message}' }], payload);
    expect(body.text).to.equal(payload.log);
  });

  it('keeps plain text with variables as a raw string', () => {
    const body = buildBody([{ key: 'text', value: 'Process {process_name} logged $&' }], payload);
    expect(body.text).to.equal('Process api logged $&');
  });

  it('parses numbers, booleans and arrays without variables', () => {
    const body = buildBody(
      [
        { key: 'n', value: '5' },
        { key: 'b', value: 'true' },
        { key: 'a', value: '[1, "x"]' },
      ],
      payload,
    );
    expect(body).to.deep.equal({ n: 5, b: true, a: [1, 'x'] });
  });

  it('keeps escaped quotes in the template intact', () => {
    const body = buildBody([{ key: 'p', value: '{"msg": "a \\" {process_name}"}' }], payload);
    expect(body.p).to.deep.equal({ msg: 'a " api' });
  });

  it('skips entries without a key', () => {
    expect(buildBody([{ key: ' ', value: '1' }], payload)).to.deep.equal({});
  });
});
