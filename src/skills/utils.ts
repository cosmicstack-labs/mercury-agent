/**
 * @fileoverview Skill Utilities - Validation and Helper Functions
 * 
 * Provides validation functions and utilities for skill management.
 * Follows Mercury's Agentic Expertise principles:
 * - Token-conscious: efficient validation
 * - Self-documenting: clear function documentation
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillMeta } from './types.js';
import { SkillLoader } from './loader.js';
import { logger } from '../utils/logger.js';

const SKILL_FILE = 'SKILL.md';

// Characters allowed in skill names (filesystem-safe, URL-friendly)
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Subdirectories allowed for write_file/remove_file
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);

/** Maximum skill name length */
export const MAX_NAME_LENGTH = 64;
/** Maximum description length */
export const MAX_DESCRIPTION_LENGTH = 1024;
/** Maximum SKILL.md content length (~36k tokens at 2.75 chars/token) */
export const MAX_SKILL_CONTENT_CHARS = 100_000;
/** Maximum supporting file size (1 MiB) */
export const MAX_SKILL_FILE_BYTES = 1_048_576;

/**
 * Validate a skill name.
 * @param name - Skill name to validate
 * @returns Error message or null if valid
 */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Skill name is required.';
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`;
  }
  return null;
}

/**
 * Validate an optional category name.
 * @param category - Category to validate
 * @returns Error message or null if valid
 */
export function validateCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  if (typeof category !== 'string') return 'Category must be a string.';

  category = category.trim();
  if (!category) return null;

  if (category.includes('/') || category.includes('\\')) {
    return `Invalid category '${category}'. Categories must be a single directory name.`;
  }
  if (category.length > MAX_NAME_LENGTH) return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!VALID_NAME_RE.test(category)) {
    return `Invalid category '${category}'. Use lowercase letters, numbers, hyphens, dots, and underscores.`;
  }
  return null;
}

/**
 * Validate that SKILL.md content has proper frontmatter with required fields.
 * @param content - SKILL.md content to validate
 * @returns Error message or null if valid
 */
export function validateSkillContent(content: string): string | null {
  if (!content.trim()) return 'Content cannot be empty.';

  if (!content.startsWith('---')) {
    return 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.';
  }

  const endMatch = content.slice(3).match(/\n---\s*\n/);
  if (!endMatch) {
    return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  }

  const yamlContent = content.slice(3, endMatch.index! + 3);
  const body = content.slice(endMatch.index! + endMatch[0].length + 3).trim();

  if (!body) {
    return 'SKILL.md must have content after the frontmatter (instructions, procedures, etc.).';
  }

  return null;
}

/**
 * Validate that content doesn't exceed the character limit.
 * @param content - Content to check
 * @param label - Label for error messages
 * @returns Error message or null if valid
 */
export function validateContentSize(content: string, label = 'SKILL.md'): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `${label} content is ${content.length.toLocaleString()} characters (limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). Consider splitting into a smaller SKILL.md with supporting files in references/ or templates/.`;
  }
  return null;
}

/**
 * Validate a file path for write_file/remove_file.
 * @param filePath - File path to validate
 * @returns Error message or null if valid
 */
export function validateFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required.';

  // Prevent path traversal
  if (filePath.includes('..')) {
    return "Path traversal ('..') is not allowed.";
  }

  const parts = filePath.split('/').filter(Boolean);
  if (parts.length === 0 || !ALLOWED_SUBDIRS.has(parts[0])) {
    return `File must be under one of: ${[...ALLOWED_SUBDIRS].join(', ')}. Got: '${filePath}'`;
  }

  if (parts.length < 2) {
    return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
  }

  return null;
}

/**
 * Check if a skill path is within the local SKILLS_DIR.
 * @param skillPath - Skill directory path
 * @param skillsDir - Skills base directory
 * @returns True if the skill is local (can be modified)
 */
export function isLocalSkill(skillPath: string, skillsDir: string): boolean {
  try {
    const skillResolved = skillPath.replace(/\\/g, '/');
    const dirResolved = skillsDir.replace(/\\/g, '/');
    return skillResolved.startsWith(dirResolved + '/') || skillResolved === dirResolved;
  } catch {
    return false;
  }
}

/**
 * Get all skill directories (local + external if configured).
 * @param skillsDir - Primary skills directory
 * @returns Array of skill directory paths
 */
export function getAllSkillsDirs(skillsDir: string): string[] {
  const dirs = [skillsDir];
  // Could add support for external_dirs from config in the future
  return dirs.filter(d => existsSync(d));
}

/**
 * Find a skill by name across all skill directories.
 * @param name - Skill name to find
 * @param skillsDir - Primary skills directory
 * @returns Skill directory path or null if not found
 */
export function findSkill(name: string, skillsDir: string): string | null {
  for (const dir of getAllSkillsDirs(skillsDir)) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const skillPath = join(dir, entry.name, SKILL_FILE);
      if (!existsSync(skillPath)) continue;

      // Load and check the skill's actual name from frontmatter
      try {
        const content = readFileSync(skillPath, 'utf-8');
        const meta = extractFrontmatter(content);
        if (meta && meta.name === name) {
          return join(dir, entry.name);
        }
        // Also check by directory name for backward compatibility
        if (entry.name === name) {
          return join(dir, entry.name);
        }
      } catch {
        // Fall back to directory name match
        if (entry.name === name) {
          return join(dir, entry.name);
        }
      }
    }
  }
  return null;
}

/**
 * Extract YAML frontmatter from SKILL.md content.
 * @param content - SKILL.md content
 * @returns Parsed frontmatter or null if invalid
 */
export function extractFrontmatter(content: string): SkillMeta | null {
  if (!content.startsWith('---')) return null;

  const endMatch = content.slice(3).match(/\n---\s*\n/);
  if (!endMatch) return null;

  const yamlContent = content.slice(3, endMatch.index! + 3);
  try {
    const { parse } = require('yaml');
    const meta = parse(yamlContent) as SkillMeta;
    return meta;
  } catch {
    return null;
  }
}

/**
 * Resolve skill directory path.
 * @param name - Skill name
 * @param category - Optional category
 * @param skillsDir - Skills base directory
 * @returns Full path to skill directory
 */
export function resolveSkillDir(name: string, category: string | null, skillsDir: string): string {
  if (category) {
    return join(skillsDir, category, name);
  }
  return join(skillsDir, name);
}