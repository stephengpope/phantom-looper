// @phantom-agent-sdk/server — what a phantom server runs. User space hands
// PhantomServer.create a config and gets the server back.
export { PhantomServer, type PhantomServerConfig } from './PhantomServer.js';
export * from './members.js';
export type { SettingDefinition, AgentTypeDefinition, ToolDefinition, ToolRunContext, ToolGroup, RouteRegistrar } from './doors.js';
