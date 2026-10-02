// @phantom@phantom-agent-sdk/backend — what a phantom server runs. User space hands
// PhantomBackend.create a config and gets the server back.
export { PhantomBackend, type PhantomBackendConfig } from './PhantomBackend.js';
export * from './members.js';
export type { SettingDefinition, AgentTypeDefinition, ToolDefinition, ToolRunContext, ToolGroup, RouteRegistrar } from './doors.js';
