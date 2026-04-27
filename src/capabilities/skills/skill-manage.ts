/**
 * @fileoverview Skill Management Tool - Agent-Managed Skill Creation & Editing
 * 
 * This tool allows the agent to create, update, and delete skills, turning successful
 * approaches into reusable procedural knowledge. New skills are created in
 * ~/.mercury/skills/. Existing skills can be modified or deleted wherever they live.
 * 
 * Skills are the agent's procedural memory: they capture *how to do a specific
 * type of task* based on proven experience. General memory (Second Brain) is
 * broad and declarative. Skills are narrow and actionable.
 * 
 * Actions:
 * - create     -- Create a new skill (SKILL.md + directory structure)
 * - edit       -- Replace the SKILL.md content of a user skill (full rewrite)
 * - patch      -- Targeted find-and-replace within SKILL.md or supporting files
 * - delete     -- Remove a user skill entirely
 * - write-file -- Add/overwrite a supporting file (reference, template, script, asset)
 * - remove-file-- Remove a supporting file from a user skill
 */

import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getMercuryHome } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import type { SkillLoader } from '../../skills/loader.js';
import {
  validateSkillName,
  validateCategory,
  validateSkillContent,
  validateContentSize,
  validateFilePath,
  isLocalSkill,
  findSkill,
  resolveSkillDir,
  extractFrontmatter,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_FILE_BYTES,
} from '../../skills/utils.js';

const SKILL_FILE = 'SKILL.md';

/** Allowed subdirectories for supporting files */
const ALLOWED_SUBDIRS = ['references', 'templates', 'scripts', 'assets'];

/**
 * Parameters for the skill_manage tool
 * @interface SkillManageParams
 */
interface SkillManageParams {
  /** The action to perform */
  action: 'create' | 'patch' | 'edit' | 'delete' | 'write-file' | 'remove-file';
  /** Skill name (lowercase, hyphens/underscores, max 64 chars) */
  name: string;
  /** Full SKILL.md content for create/edit actions */
  content?: string;
  /** Text to find (required for patch) */
  oldString?: string;
  /** Replacement text (required for patch) */
  newString?: string;
  /** Optional category for organization */
  category?: string;
  /** Path to a supporting file */
  filePath?: string;
  /** Content for write-file action */
  fileContent?: string;
  /** Replace all occurrences (for patch) */
  replaceAll?: boolean;
}

/**
 * Result object for skill management operations
 * @interface SkillManageResult
 */
interface SkillManageResult {
  success: boolean;
  message?: string;
  error?: string;
  path?: string;
  skillMd?: string;
  category?: string;
  hint?: string;
  availableFiles?: string[];
  filePreview?: string;
}

/**
 * Atomic write - writes to temp file first, then replaces target.
 * Ensures target is never left in partially-written state.
 * @param filePath - Target file path
 * @param content - Content to write
 * @param encoding - Text encoding (default: utf-8)
 */
function atomicWrite(filePath: string, content: string, encoding: BufferEncoding = 'utf-8'): void {
  const tempDir = dirname(filePath);
  const fileName = filePath.split(/[/\\]/).pop() || 'tmp';
  const tempPath = join(tempDir, `.${fileName}.tmp.${Date.now()}`);

  try {
    writeFileSync(tempPath, content, encoding);
    // Atomic rename
    try {
      const { renameSync } = require('node:fs');
      renameSync(tempPath, filePath);
    } catch {
      // Fallback: copy content and delete temp
      writeFileSync(filePath, content, encoding);
      try { unlinkSync(tempPath); } catch { /* ignore */ }
    }
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Create a new skill with SKILL.md content.
 * @param name - Skill name
 * @param content - Full SKILL.md content with YAML frontmatter
 * @param category - Optional category for organization
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function createSkill(
  name: string,
  content: string,
  category: string | null,
  skillsDir: string
): SkillManageResult {
  // Validate name
  const nameErr = validateSkillName(name);
  if (nameErr) return { success: false, error: nameErr };

  // Validate category
  const catErr = validateCategory(category);
  if (catErr) return { success: false, error: catErr };

  // Validate content
  const contentErr = validateSkillContent(content);
  if (contentErr) return { success: false, error: contentErr };

  // Validate size
  const sizeErr = validateContentSize(content);
  if (sizeErr) return { success: false, error: sizeErr };

  // Check for name collisions
  const existing = findSkill(name, skillsDir);
  if (existing) {
    return { success: false, error: `A skill named '${name}' already exists at ${existing}.` };
  }

  // Create the skill directory
  const skillDir = resolveSkillDir(name, category, skillsDir);
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }

  // Write SKILL.md
  const skillMd = join(skillDir, SKILL_FILE);
  try {
    atomicWrite(skillMd, content);
  } catch (err: any) {
    return { success: false, error: `Failed to write skill file: ${err.message}` };
  }

  logger.info({ skill: name, path: skillDir }, 'Skill created');

  const result: SkillManageResult = {
    success: true,
    message: `Skill '${name}' created.`,
    path: skillDir.replace(/\\/g, '/').replace(skillsDir.replace(/\\/g, '/') + '/', ''),
    skillMd,
  };

  if (category) {
    result.category = category;
  }

  result.hint = `To add reference files, templates, or scripts, use skill_manage(action='write-file', name='${name}', file_path='references/example.md', file_content='...')`;

  return result;
}

/**
 * Edit/replace the SKILL.md of an existing skill.
 * @param name - Skill name
 * @param content - Full updated SKILL.md content
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function editSkill(name: string, content: string, skillsDir: string): SkillManageResult {
  // Validate content
  const contentErr = validateSkillContent(content);
  if (contentErr) return { success: false, error: contentErr };

  // Validate size
  const sizeErr = validateContentSize(content);
  if (sizeErr) return { success: false, error: sizeErr };

  const skillDir = findSkill(name, skillsDir);
  if (!skillDir) {
    return { success: false, error: `Skill '${name}' not found. Use list_skills to see available skills.` };
  }

  if (!isLocalSkill(skillDir, skillsDir)) {
    return { success: false, error: `Skill '${name}' is in an external directory and cannot be modified.` };
  }

  const skillMd = join(skillDir, SKILL_FILE);

  try {
    atomicWrite(skillMd, content);
  } catch (err: any) {
    return { success: false, error: `Failed to write skill file: ${err.message}` };
  }

  logger.info({ skill: name }, 'Skill updated');

  return {
    success: true,
    message: `Skill '${name}' updated.`,
    path: skillDir.replace(/\\/g, '/').replace(skillsDir.replace(/\\/g, '/') + '/', ''),
  };
}

/**
 * Patch a skill file with find-and-replace.
 * @param name - Skill name
 * @param oldString - Text to find
 * @param newString - Replacement text (can be empty to delete)
 * @param filePath - Optional file path (defaults to SKILL.md)
 * @param replaceAll - Replace all occurrences
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function patchSkill(
  name: string,
  oldString: string,
  newString: string | null,
  filePath: string | null,
  replaceAll: boolean,
  skillsDir: string
): SkillManageResult {
  if (!oldString) {
    return { success: false, error: 'old_string is required for patch.' };
  }

  if (newString === undefined) {
    return { success: false, error: "new_string is required for patch. Use empty string to delete matched text." };
  }

  const skillDir = findSkill(name, skillsDir);
  if (!skillDir) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  if (!isLocalSkill(skillDir, skillsDir)) {
    return { success: false, error: `Skill '${name}' is in an external directory and cannot be modified.` };
  }

  let targetPath: string;
  if (filePath) {
    const pathErr = validateFilePath(filePath);
    if (pathErr) return { success: false, error: pathErr };

    if (filePath.includes('..')) {
      return { success: false, error: "Path traversal ('..') is not allowed." };
    }
    targetPath = join(skillDir, filePath);
  } else {
    targetPath = join(skillDir, SKILL_FILE);
  }

  if (!existsSync(targetPath)) {
    return { success: false, error: `File not found: ${filePath || 'SKILL.md'}` };
  }

  const content = readFileSync(targetPath, 'utf-8');
  let matchCount = 0;
  let newContent: string;

  if (replaceAll) {
    const regex = new RegExp(escapeRegex(oldString), 'g');
    const matches = content.match(regex);
    matchCount = matches ? matches.length : 0;
    newContent = content.replace(regex, newString ?? '');
  } else {
    const idx = content.indexOf(oldString);
    if (idx === -1) {
      const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');
      return {
        success: false,
        error: `Could not find '${oldString.length > 50 ? oldString.slice(0, 50) + '...' : oldString}' in the file. Make sure the text matches exactly.`,
        filePreview: preview,
      };
    }
    matchCount = 1;
    newContent = content.slice(0, idx) + (newString ?? '') + content.slice(idx + oldString.length);
  }

  // Validate size
  const sizeErr = validateContentSize(newContent, filePath || 'SKILL.md');
  if (sizeErr) return { success: false, error: sizeErr };

  // If patching SKILL.md, validate frontmatter still intact
  if (!filePath) {
    const contentErr = validateSkillContent(newContent);
    if (contentErr) {
      return { success: false, error: `Patch would break SKILL.md structure: ${contentErr}` };
    }
  }

  try {
    atomicWrite(targetPath, newContent);
  } catch (err: any) {
    return { success: false, error: `Failed to write file: ${err.message}` };
  }

  logger.info({ skill: name, file: filePath || 'SKILL.md', count: matchCount }, 'Skill patched');

  return {
    success: true,
    message: `Patched ${filePath || 'SKILL.md'} in skill '${name}' (${matchCount} replacement${matchCount !== 1 ? 's' : ''}).`,
    path: skillDir.replace(/\\/g, '/').replace(skillsDir.replace(/\\/g, '/') + '/', ''),
  };
}

/**
 * Delete a skill.
 * @param name - Skill name
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function deleteSkill(name: string, skillsDir: string): SkillManageResult {
  const skillDir = findSkill(name, skillsDir);
  if (!skillDir) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  if (!isLocalSkill(skillDir, skillsDir)) {
    return { success: false, error: `Skill '${name}' is in an external directory and cannot be deleted.` };
  }

  try {
    // Delete all files in the skill directory
    const deleteRecursive = (dir: string) => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          deleteRecursive(fullPath);
          try { rmdirSync(fullPath); } catch { /* ignore */ }
        } else {
          try { unlinkSync(fullPath); } catch { /* ignore */ }
        }
      }
    };
    deleteRecursive(skillDir);

    // Remove the skill directory itself
    try { rmdirSync(skillDir); } catch { /* ignore */ }

    // Clean up empty category directories
    const parent = dirname(skillDir);
    if (parent !== skillsDir && existsSync(parent)) {
      try {
        if (readdirSync(parent).length === 0) {
          rmdirSync(parent);
        }
      } catch { /* ignore */ }
    }
  } catch (err: any) {
    return { success: false, error: `Failed to delete skill: ${err.message}` };
  }

  logger.info({ skill: name }, 'Skill deleted');

  return {
    success: true,
    message: `Skill '${name}' deleted.`,
  };
}

/**
 * Write a supporting file to a skill.
 * @param name - Skill name
 * @param filePath - Path within skill (references/, templates/, scripts/, assets/)
 * @param fileContent - Content to write
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function writeSkillFile(
  name: string,
  filePath: string,
  fileContent: string,
  skillsDir: string
): SkillManageResult {
  const pathErr = validateFilePath(filePath);
  if (pathErr) return { success: false, error: pathErr };

  if (fileContent === undefined) {
    return { success: false, error: 'file_content is required for write-file.' };
  }

  const skillDir = findSkill(name, skillsDir);
  if (!skillDir) {
    return { success: false, error: `Skill '${name}' not found. Create it first with action='create'.` };
  }

  if (!isLocalSkill(skillDir, skillsDir)) {
    return { success: false, error: `Skill '${name}' is in an external directory and cannot be modified.` };
  }

  // Check size
  const contentBytes = Buffer.byteLength(fileContent, 'utf-8');
  if (contentBytes > MAX_SKILL_FILE_BYTES) {
    return {
      success: false,
      error: `File content is ${contentBytes.toLocaleString()} bytes (limit: ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes / 1 MiB). Consider splitting into smaller files.`,
    };
  }

  const sizeErr = validateContentSize(fileContent, filePath);
  if (sizeErr) return { success: false, error: sizeErr };

  const targetPath = join(skillDir, filePath);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    atomicWrite(targetPath, fileContent);
  } catch (err: any) {
    return { success: false, error: `Failed to write file: ${err.message}` };
  }

  logger.info({ skill: name, file: filePath }, 'Skill file written');

  return {
    success: true,
    message: `File '${filePath}' written to skill '${name}'.`,
    path: targetPath,
  };
}

/**
 * Remove a supporting file from a skill.
 * @param name - Skill name
 * @param filePath - Path within skill to remove
 * @param skillsDir - Skills directory path
 * @returns SkillManageResult with success/error
 */
function removeSkillFile(name: string, filePath: string, skillsDir: string): SkillManageResult {
  const pathErr = validateFilePath(filePath);
  if (pathErr) return { success: false, error: pathErr };

  const skillDir = findSkill(name, skillsDir);
  if (!skillDir) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  if (!isLocalSkill(skillDir, skillsDir)) {
    return { success: false, error: `Skill '${name}' is in an external directory and cannot be modified.` };
  }

  const targetPath = join(skillDir, filePath);
  if (!existsSync(targetPath)) {
    // List available files for feedback
    const available: string[] = [];
    for (const subdir of ALLOWED_SUBDIRS) {
      const subdirPath = join(skillDir, subdir);
      if (existsSync(subdirPath)) {
        const files = readdirSync(subdirPath);
        for (const f of files) {
          available.push(`${subdir}/${f}`);
        }
      }
    }
    return {
      success: false,
      error: `File '${filePath}' not found in skill '${name}'.`,
      availableFiles: available.length > 0 ? available : undefined,
    };
  }

  try {
    unlinkSync(targetPath);

    // Clean up empty subdirectories
    const subdirPath = dirname(targetPath);
    if (subdirPath !== skillDir && existsSync(subdirPath)) {
      try {
        if (readdirSync(subdirPath).length === 0) {
          rmdirSync(subdirPath);
        }
      } catch { /* ignore */ }
    }
  } catch (err: any) {
    return { success: false, error: `Failed to remove file: ${err.message}` };
  }

  logger.info({ skill: name, file: filePath }, 'Skill file removed');

  return {
    success: true,
    message: `File '${filePath}' removed from skill '${name}'.`,
  };
}

/**
 * Escape special regex characters in a string.
 * @param str - String to escape
 * @returns Escaped string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates the skill_manage tool for the capability registry.
 * @param skillLoader - The skill loader instance for discovery refresh
 * @returns AI tool definition for skill management
 */
export function createSkillManageTool(skillLoader: SkillLoader) {
  return tool({
    description: `Manage skills (create, update, delete). Skills are your procedural memory - reusable approaches for recurring task types. Skills go to ~/.mercury/skills/; existing skills can be modified wherever they live.

Actions:
- create: Create a new skill (SKILL.md + optional category subdirectory)
- patch: Targeted find-and-replace within SKILL.md or supporting files (preferred for fixes)
- edit: Full SKILL.md rewrite (for major overhauls only)
- delete: Remove a user skill entirely
- write-file: Add/overwrite a supporting file (reference, template, script, asset)
- remove-file: Remove a supporting file from a skill

Create when: complex task succeeded (5+ tool calls), errors overcame, user-corrected approach worked, non-trivial workflow discovered, or user asks to remember a procedure.
Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use. If you used a skill and hit issues not covered, patch it immediately.
Prefer updating/patching existing skills over creating new ones. Survey existing skills first (list_skills, then skill_view) before creating.
Confirm with user before creating/deleting skills.
Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.`,

    inputSchema: zodSchema(z.object({
      action: z.enum(['create', 'patch', 'edit', 'delete', 'write-file', 'remove-file']).describe('The action to perform.'),
      name: z.string().max(MAX_NAME_LENGTH).describe('Skill name (lowercase, hyphens/underscores, max 64 chars). Must match existing skill for patch/edit/delete/write-file/remove-file.'),
      content: z.string().optional().describe('Full SKILL.md content (YAML frontmatter + markdown body). Required for create and edit.'),
      oldString: z.string().optional().describe('Text to find in the file (required for patch). Include enough context to ensure uniqueness unless replaceAll=true.'),
      newString: z.string().optional().describe('Replacement text (required for patch). Can be empty string to delete matched text.'),
      replaceAll: z.boolean().optional().describe('For patch: replace all occurrences instead of requiring unique match (default: false).'),
      category: z.string().optional().describe('Optional category/domain for organizing the skill (e.g., devops, data-science, mlops). Creates a subdirectory grouping. Only for create.'),
      filePath: z.string().optional().describe('Path to a supporting file within the skill directory. For write-file/remove-file: required, must be under references/, templates/, scripts/, or assets/. For patch: optional, defaults to SKILL.md.'),
      fileContent: z.string().optional().describe('Content for the file. Required for write-file.'),
    })),

    execute: async ({ action, name, content, oldString, newString, replaceAll, category, filePath, fileContent }: SkillManageParams) => {
      const skillsDir = join(getMercuryHome(), 'skills');

      let result: SkillManageResult;

      switch (action) {
        case 'create':
          if (!content) {
            result = { success: false, error: 'content is required for create. Provide the full SKILL.md text (frontmatter + body).' };
          } else {
            result = createSkill(name, content, category || null, skillsDir);
          }
          break;

        case 'edit':
          if (!content) {
            result = { success: false, error: 'content is required for edit. Provide the full updated SKILL.md text.' };
          } else {
            result = editSkill(name, content, skillsDir);
          }
          break;

        case 'patch':
          result = patchSkill(name, oldString || '', newString ?? null, filePath || null, replaceAll || false, skillsDir);
          break;

        case 'delete':
          result = deleteSkill(name, skillsDir);
          break;

        case 'write-file':
          if (!filePath) {
            result = { success: false, error: "file_path is required for write-file. Example: 'references/example.md'" };
          } else if (fileContent === undefined) {
            result = { success: false, error: 'file_content is required for write-file.' };
          } else {
            result = writeSkillFile(name, filePath, fileContent, skillsDir);
          }
          break;

        case 'remove-file':
          if (!filePath) {
            result = { success: false, error: 'file_path is required for remove-file.' };
          } else {
            result = removeSkillFile(name, filePath, skillsDir);
          }
          break;

        default:
          result = { success: false, error: `Unknown action '${action}'. Use: create, patch, edit, delete, write-file, remove-file.` };
      }

      // Refresh skill discovery after successful changes
      if (result.success && ['create', 'edit', 'patch', 'delete', 'write-file', 'remove-file'].includes(action)) {
        skillLoader.discover();
      }

      if (result.success) {
        return JSON.stringify(result, null, 2);
      } else {
        return `Error: ${result.error}${result.filePreview ? `\n\nFile preview:\n${result.filePreview}` : ''}`;
      }
    },
  });
}