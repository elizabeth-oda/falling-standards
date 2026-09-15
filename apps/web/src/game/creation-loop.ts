import { CreationSpecSchema, type CreationClient, type CreationSpec, type PowerUpEffect } from '@sky/shared';
import type { PromptCapture } from '../voice/types';
import type { AudioCreationClient } from '../voice/voice-client';
import { CreationAttempt } from './creation-attempt';
export type { Phase, CreationSnapshot } from './creation-attempt';

export interface CreationHost {
  spawnCreation(instanceId:string,spec:CreationSpec):void;
  applyEffects(effects:PowerUpEffect[]):void;
}
/** Legacy v2 demo adapter. */
export class CreationLoop extends CreationAttempt<CreationSpec> {
  constructor(client:CreationClient,voice:PromptCapture,host:CreationHost,audioClient?:AudioCreationClient) {
    super(client,voice,{
      parse:value=>CreationSpecSchema.parse(value),
      spawnCreation:(id,spec)=>host.spawnCreation(id,spec),
      activate:spec=>host.applyEffects(spec.effects),
    },audioClient);
  }
}
