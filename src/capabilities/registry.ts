import type { Tool } from 'ai';
import { PermissionManager } from './permissions.js';
import { createReadFileTool } from './filesystem/read-file.js';
import { createWriteFileTool } from './filesystem/write-file.js';
import { createCreateFileTool } from './filesystem/create-file.js';
import { createListDirTool } from './filesystem/list-dir.js';
import { createDeleteFileTool } from './filesystem/delete-file.js';
import { createRunCommandTool } from './shell/run-command.js';
import { createInstallSkillTool } from './skills/install-skill.js';
import { createListSkillsTool } from './skills/list-skills.js';
import { createUseSkillTool } from './skills/use-skill.js';
import { createScheduleTaskTool } from './scheduler/schedule-task.js';
import { createListTasksTool } from './scheduler/list-tasks.js';
import { createCancelTaskTool } from './scheduler/cancel-task.js';
import type { SkillLoader } from '../skills/loader.js';
import type { Scheduler } from '../core/scheduler.js';
import { logger } from '../utils/logger.js';

export class CapabilityRegistry {
  readonly permissions: PermissionManager;
  private tools: Record<string, Tool> = {};
  private skillLoader?: SkillLoader;
  private scheduler?: Scheduler;

  constructor(skillLoader?: SkillLoader, scheduler?: Scheduler) {
    this.permissions = new PermissionManager();
    this.skillLoader = skillLoader;
    this.scheduler = scheduler;
    this.registerAll();
  }

  private registerAll(): void {
    const manifest = this.permissions.getManifest();

    if (manifest.capabilities.filesystem.enabled) {
      this.tools.read_file = createReadFileTool(this.permissions);
      this.tools.write_file = createWriteFileTool(this.permissions);
      this.tools.create_file = createCreateFileTool(this.permissions);
      this.tools.list_dir = createListDirTool(this.permissions);
      this.tools.delete_file = createDeleteFileTool(this.permissions);
      logger.info('Filesystem tools registered');
    }

    if (manifest.capabilities.shell.enabled) {
      this.tools.run_command = createRunCommandTool(this.permissions);
      logger.info('Shell tool registered');
    }

    if (this.skillLoader) {
      this.tools.install_skill = createInstallSkillTool(this.skillLoader);
      this.tools.list_skills = createListSkillsTool(this.skillLoader);
      this.tools.use_skill = createUseSkillTool(this.skillLoader, this.permissions);
      logger.info('Skill tools registered');
    }

    if (this.scheduler) {
      this.tools.schedule_task = createScheduleTaskTool(this.scheduler);
      this.tools.list_scheduled_tasks = createListTasksTool(this.scheduler);
      this.tools.cancel_scheduled_task = createCancelTaskTool(this.scheduler);
      logger.info('Scheduler tools registered');
    }
  }

  getTools(): Record<string, Tool> {
    return this.tools;
  }

  getToolNames(): string[] {
    return Object.keys(this.tools);
  }

  getSkillContext(): string {
    return this.skillLoader?.getSkillSummariesText() || '';
  }
}