import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, parseTelemetry, toPoint } from './geo.js';

test('haversine distance is approximately correct for a short GPS separation', () => {
  const a=toPoint(0,0), b=toPoint(0,0.001);
  assert.ok(Math.abs(haversineMeters(a,b)-111.2)<1);
});

test('telemetry rejects impossible coordinates', () => {
  assert.equal(parseTelemetry({lat:91,lng:0,accuracy:5}),null);
  assert.equal(parseTelemetry({lat:0,lng:181,accuracy:5}),null);
});

test('telemetry clamps invalid accuracy conservatively', () => {
  const fix=parseTelemetry({lat:18.5,lng:73.8,accuracy:NaN});
  assert.equal(fix.accuracy,10000);
});
