import type { AnyToolDef } from "./defineTool.js";
import { utilityTools } from "./utility.js";
import { jsmTools } from "./jsm.js";
import { assetsTools } from "./assets.js";
import { automationTools } from "./automation.js";
import { customFieldTools } from "./customfields.js";
import { projectTools } from "./projects.js";
import { schemeTools } from "./schemes.js";
import { workflowTools } from "./workflows.js";
import { confluenceAdminTools } from "./confluence.js";
import { deleteProjectTools } from "./deleteProjects.js";
import { agileTools } from "./agile.js";
import { filterDashboardTools } from "./filtersDashboards.js";
import { orgAdminTools } from "./orgAdmin.js";

export function allTools(): AnyToolDef[] {
  return [
    ...utilityTools(),
    ...jsmTools(),
    ...assetsTools(),
    ...automationTools(),
    ...customFieldTools(),
    ...projectTools(),
    ...schemeTools(),
    ...workflowTools(),
    ...confluenceAdminTools(),
    ...deleteProjectTools(),
    ...agileTools(),
    ...filterDashboardTools(),
    ...orgAdminTools(),
  ];
}
