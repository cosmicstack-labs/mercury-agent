/**
 * @fileoverview Tests for Self-Improving Skill System
 * 
 * Tests skill_manage, skill_view tools and SkillTracker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock skill loader
const mockSkillLoader = {
  discover: vi.fn(),
};

describe('Skill Utils', () => {
  const testSkillsDir = join(tmpdir(), 'mercury-test-skills');
  
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(testSkillsDir)) {
      rmSync(testSkillsDir, { recursive: true, force: true });
    }
    mkdirSync(testSkillsDir, { recursive: true });
  });

  describe('validateSkillName', () => {
    it('should accept valid skill names', async () => {
      const { validateSkillName } = await import('../src/skills/utils.js');
      
      expect(validateSkillName('docker-debug')).toBeNull();
      expect(validateSkillName('api_error_handler')).toBeNull();
      expect(validateSkillName('test123')).toBeNull();
    });

    it('should reject invalid skill names', async () => {
      const { validateSkillName } = await import('../src/skills/utils.js');
      
      expect(validateSkillName('')).toBe('Skill name is required.');
      expect(validateSkillName('Test-Skill')).toContain('lowercase');
      expect(validateSkillName('-test')).toContain('start with a letter or digit');
      expect(validateSkillName('a'.repeat(65))).toContain('exceeds');
    });
  });

  describe('validateSkillContent', () => {
    it('should accept valid SKILL.md content', async () => {
      const { validateSkillContent } = await import('../src/skills/utils.js');
      
      const validContent = `---
name: test-skill
description: A test skill
---
# Test Skill
Content here.`;
      
      expect(validateSkillContent(validContent)).toBeNull();
    });

    it('should reject invalid SKILL.md content', async () => {
      const { validateSkillContent } = await import('../src/skills/utils.js');
      
      expect(validateSkillContent('')).toBe('Content cannot be empty.');
      expect(validateSkillContent('No frontmatter')).toContain('YAML frontmatter');
      expect(validateSkillContent('---\nname: test\n---\n')).toContain('content after the frontmatter');
    });
  });

  describe('findSkill', () => {
    it('should find existing skills by directory name', async () => {
      const { findSkill, resolveSkillDir } = await import('../src/skills/utils.js');
      
      // Create a test skill
      const skillDir = resolveSkillDir('test-skill', null, testSkillsDir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: test-skill
description: Test
---
# Test`);
      
      const found = findSkill('test-skill', testSkillsDir);
      expect(found).not.toBeNull();
      expect(found).toContain('test-skill');
    });

    it('should return null for non-existent skills', async () => {
      const { findSkill } = await import('../src/skills/utils.js');
      
      const found = findSkill('non-existent', testSkillsDir);
      expect(found).toBeNull();
    });
  });
});

describe('SkillTracker', () => {
  it('should track iterations', async () => {
    const { SkillTracker } = await import('../src/skills/review.js');
    
    const tracker = new SkillTracker({ nudgeInterval: 5 });
    
    expect(tracker.shouldTriggerReview()).toBe(false);
    
    tracker.recordIteration();
    tracker.recordIteration();
    tracker.recordIteration();
    
    expect(tracker.shouldTriggerReview()).toBe(false);
    
    tracker.recordIteration();
    tracker.recordIteration();
    
    expect(tracker.shouldTriggerReview()).toBe(true);
  });

  it('should reset on skill action', async () => {
    const { SkillTracker } = await import('../src/skills/review.js');
    
    const tracker = new SkillTracker({ nudgeInterval: 3 });
    
    tracker.recordIteration();
    tracker.recordIteration();
    tracker.recordIteration();
    expect(tracker.shouldTriggerReview()).toBe(true);
    
    tracker.recordSkillAction();
    expect(tracker.shouldTriggerReview()).toBe(false);
    expect(tracker.getIterationCount()).toBe(0);
  });
});

describe('Skill Review', () => {
  it('should suggest skill names from tasks', async () => {
    const { suggestSkillName } = await import('../src/skills/review.js');
    
    const name1 = suggestSkillName('How to debug Docker issues');
    expect(name1).toMatch(/docker.*debug.*issues|debug.*docker.*issues/);
    expect(name1).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    
    const name2 = suggestSkillName('API Error Handling');
    expect(name2).toBe('api-error-handling');
  });

  it('should suggest descriptions from context', async () => {
    const { suggestSkillDescription } = await import('../src/skills/review.js');
    
    const desc = suggestSkillDescription('This workflow helps debug Docker container issues step by step.');
    expect(desc).toContain('debug');
    expect(desc).toContain('Docker');
  });
});
