import test from 'node:test';
import assert from 'node:assert/strict';
import { sweptPickup } from './world-geometry';
import { segmentSphere } from './race-course';

for (const [name, contact] of [['sweptPickup', sweptPickup], ['segmentSphere', segmentSphere]] as const) {
  test(`${name} handles stationary, tangent, and swept contacts`, () => {
    assert.equal(contact([0, 0, 0], [0, 0, 0], [0, 0, 0], 0), true);
    assert.equal(contact([0, 0, 0], [0, 0, 0], [0, 2, 0], 1), false);
    assert.equal(contact([-2, 0, 0], [2, 0, 0], [0, 1, 0], 1), true);
    assert.equal(contact([-2, 0, 0], [2, 0, 0], [0, 1.01, 0], 1), false);
    assert.equal(contact([0, 0, 0], [1, 0, 0], [2, 0, 0], 0.5), false);
    assert.equal(contact([0, 0, 0], [1, 0, 0], [-1, 0, 0], 0.5), false);
    assert.equal(contact([-50, 50, 50], [50, -50, -50], [0, 0, 0], 1), true);
    assert.equal(contact([0, 0, 0], [0, 0, 0], [0, 0, 0], -1), false);
  });
}
