import { z } from 'zod';
import { EffectSchema, GenerationRequestSchema, PowerUpSpecSchema } from './schema.js';
import { MeshAppearanceSchema, PrimitiveAppearanceSchema } from './creation.js';

export const PIPELINE_DEADLINE_MS = 30_000;
export const DESIGN_BUDGET_MS = 8_000;

export const CreationDesignSchema = z.object({
  displayName: PowerUpSpecSchema.shape.displayName,
  description: PowerUpSpecSchema.shape.description,
  visualBrief: z.string().trim().min(1).max(700),
  effect: EffectSchema,
}).strict();
// Both visual methods produce exactly one effect. Existing v1/v2 shapes are unchanged.
export const GeneratedCreationSchema = PowerUpSpecSchema.extend({
  version: z.literal(2), appearance: z.union([MeshAppearanceSchema, PrimitiveAppearanceSchema]), effects: z.array(EffectSchema).length(1),
});
export type CreationDesign = z.infer<typeof CreationDesignSchema>;
export type GeneratedCreation = z.infer<typeof GeneratedCreationSchema>;
export const GeometryModeSchema = z.enum(['mesh', 'primitives']);
export type GeometryMode = z.infer<typeof GeometryModeSchema>;
export const PipelineRequestSchema = GenerationRequestSchema.extend({
  profileId: z.string().min(1).max(48),
  // Omission preserves the existing raw-mesh API behavior; the lab selects primitives.
  geometryMode: GeometryModeSchema.optional(),
  // Client-generated dispatch metadata; confirmed is retained for API compatibility.
  paidAttempt: z.object({id:z.string().uuid(),confirmed:z.literal(true)}).strict().optional(),
});
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;
export const StageConfigSchema = z.object({
  model: z.string().min(1).max(80),
  reasoning: z.enum(['none','low','medium','high']),
  maxOutputTokens: z.number().int().min(256).max(16000),
}).strict().refine(config=>config.model!=='gpt-6-astra'||config.reasoning!=='none', {
  path:['reasoning'],message:'GPT-6 Astra requires low, medium, or high reasoning in this app.',
});
export type StageConfig = z.infer<typeof StageConfigSchema>;
export const PipelineProfileSchema = z.object({
  id: z.string(), label: z.string(), mode: z.enum(['mock','live']),
  available: z.boolean(), unavailableReason: z.string().optional(),
  design: StageConfigSchema, geometry: StageConfigSchema,
}).strict();
export type PipelineProfile = z.infer<typeof PipelineProfileSchema>;
export const LiveUsageSchema = z.object({
  enabled:z.boolean(), maxAttempts:z.number().int().min(1).max(500),
  attemptsUsed:z.number().int().nonnegative(), attemptsRemaining:z.number().int().nonnegative(), busy:z.boolean(),
}).strict();
export type LiveUsage = z.infer<typeof LiveUsageSchema>;
export const PipelineProfilesSchema = z.object({
  transcription:z.object({model:z.string().min(1).max(80),available:z.boolean()}).strict().optional(),
  profiles: z.array(PipelineProfileSchema), liveUsage:LiveUsageSchema, deadlineMs: z.literal(PIPELINE_DEADLINE_MS), designBudgetMs: z.literal(DESIGN_BUDGET_MS),
}).strict();
export const PipelineStageSchema = z.enum(['design','geometry','validation']);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
const usage = z.object({inputTokens:z.number().nonnegative(), outputTokens:z.number().nonnegative(), reasoningTokens:z.number().nonnegative().optional()}).strict();
export const StageMetricSchema = z.object({
  stage: z.enum(['design','geometry']), model: z.string(), durationMs:z.number().nonnegative(), usage:usage.optional(),
}).strict();
export type StageMetric = z.infer<typeof StageMetricSchema>;
// Only explicitly recognized provider metadata may cross the server boundary.
export const ProviderDiagnosticSchema = z.object({
  model:z.string().min(1).max(80),
  httpStatus:z.number().int().min(100).max(599).optional(),
  code:z.enum(['invalid_api_key','model_not_found','permission_denied','insufficient_permissions',
    'insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded',
    'project_spend_limit_exceeded','organization_usage_limit_exceeded','rate_limit_exceeded','slow_down',
    'invalid_json_schema','invalid_schema','invalid_value','unsupported_value','unsupported_parameter',
    'invalid_request_error','server_error','server_is_overloaded','service_unavailable']).optional(),
  transportCode:z.enum(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT']).optional(),
  parameter:z.enum(['model','reasoning','reasoning.effort','max_output_tokens','text.format','text.format.schema','input','instructions','store']).optional(),
  requestId:z.string().regex(/^req_[a-f0-9]{16,64}$/).optional(),
}).strict();
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
export const PipelineErrorSchema = z.object({
  code:z.enum(['INVALID_REQUEST','NOT_CONFIGURED','LIVE_DISABLED','CONSENT_REQUIRED','DUPLICATE_ATTEMPT','LIVE_BUSY','LIVE_LIMIT_REACHED','INVALID_DESIGN','INVALID_MESH','INVALID_RECIPE','TIMEOUT','CANCELLED','REFUSED','INCOMPLETE','PROVIDER_ERROR','PROVIDER_AUTH','MODEL_UNAVAILABLE','PROVIDER_PERMISSION','PROVIDER_QUOTA','PROVIDER_RATE_LIMIT','PROVIDER_SCHEMA','PROVIDER_REQUEST','PROVIDER_UNAVAILABLE','PROVIDER_CONNECTION','PROVIDER_TIMEOUT','INVALID_AUDIO','INVALID_TRANSCRIPT','TRANSCRIPTION_TIMEOUT']),
  message:z.string().min(1).max(240),
  provider:ProviderDiagnosticSchema.optional(),
}).strict();
export type PipelineErrorData = z.infer<typeof PipelineErrorSchema>;
/** Keep progress envelopes identical while each API retains its own payload schema. */
export function createPipelineEventSchema<D extends z.ZodTypeAny, S extends z.ZodTypeAny>(design: D, spec: S) {
  return z.discriminatedUnion('type', [
    z.object({type:z.literal('stage'), stage:PipelineStageSchema, elapsedMs:z.number().nonnegative()}).strict(),
    z.object({type:z.literal('design'), design, metric:StageMetricSchema}).strict(),
    z.object({type:z.literal('geometry'), metric:StageMetricSchema}).strict(),
    z.object({type:z.literal('complete'), spec, elapsedMs:z.number().nonnegative(), metrics:z.array(StageMetricSchema)}).strict(),
    z.object({type:z.literal('failed'), stage:PipelineStageSchema, error:PipelineErrorSchema, elapsedMs:z.number().nonnegative(), metrics:z.array(StageMetricSchema)}).strict(),
  ]);
}
export const PipelineEventSchema = createPipelineEventSchema(CreationDesignSchema, GeneratedCreationSchema);
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

const coordinate = z.number().finite().min(-3).max(3);
const vertexIndex = z.number().int().min(0).max(255);
export const GeometryWireSchema = z.object({
  vertices:z.array(z.object({x:coordinate,y:coordinate,z:coordinate}).strict()).min(3).max(256),
  faces:z.array(z.object({a:vertexIndex,b:vertexIndex,c:vertexIndex,color:z.string().regex(/^#[0-9a-fA-F]{6}$/)}).strict()).min(1).max(512),
}).strict();
