// Tests for the kubectl guide's pure logic.
//
// These matter more than typical UI tests: `canRun` is the gate that decides
// whether Kalam sends a command to a real cluster, and `buildCommand` produces
// text an operator may paste into a production terminal. Both are held to the
// rule that a mistake must fail closed.

import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  QUIZ_QUESTIONS,
  SCENARIOS,
  DEFAULT_BUILDER,
  type BuilderState,
  buildCommand,
  canRun,
  categoryCounts,
  classifyRisk,
  extractPlaceholders,
  fillPlaceholders,
  hasShellSideEffects,
  isFullyResolved,
  pickQuiz,
  riskOf,
  searchCommands,
  shuffle,
  validateBuilder,
} from '../kubectl.js';

const builder = (over: Partial<BuilderState> = {}): BuilderState => ({ ...DEFAULT_BUILDER, ...over });

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

describe('classifyRisk', () => {
  it('treats inspection verbs as read-only', () => {
    for (const c of ['kubectl get pods', 'kubectl describe node n1', 'kubectl logs p --previous', 'kubectl top pod', 'kubectl explain pod.spec', 'kubectl api-resources', 'kubectl cluster-info', 'kubectl version']) {
      expect(classifyRisk(c), c).toBe('read');
    }
  });

  it('treats state changes as mutating', () => {
    for (const c of ['kubectl apply -f x.yaml', 'kubectl scale deployment/a --replicas=3', 'kubectl rollout restart deployment/a', 'kubectl label pod p k=v', 'kubectl cordon n1', 'kubectl patch deployment a -p {}']) {
      expect(classifyRisk(c), c).toBe('mutate');
    }
  });

  it('treats deletion and eviction as destructive', () => {
    for (const c of ['kubectl delete pod p', 'kubectl drain n1 --ignore-daemonsets', 'kubectl replace --raw /finalize -f ns.json', 'kubectl taint nodes n1 k=v:NoSchedule']) {
      expect(classifyRisk(c), c).toBe('destructive');
    }
  });

  it('splits kubectl config by subcommand rather than calling it all mutating', () => {
    expect(classifyRisk('kubectl config view')).toBe('read');
    expect(classifyRisk('kubectl config get-contexts')).toBe('read');
    expect(classifyRisk('kubectl config current-context')).toBe('read');
    expect(classifyRisk('kubectl config use-context prod')).toBe('mutate');
    expect(classifyRisk('kubectl config delete-context prod')).toBe('mutate');
  });

  it('splits kubectl auth: can-i asks, reconcile writes', () => {
    expect(classifyRisk('kubectl auth can-i create pods')).toBe('read');
    expect(classifyRisk('kubectl auth reconcile -f rbac.yaml')).toBe('mutate');
  });

  it('classifies exec as mutating — a shell can do anything', () => {
    expect(classifyRisk('kubectl exec -it p -- /bin/sh')).toBe('mutate');
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(classifyRisk('  KUBECTL DELETE POD p  ')).toBe('destructive');
  });
});

describe('riskOf', () => {
  it('honours an explicit override over the derived verb', () => {
    // `rollout status` only watches, despite `rollout` being a mutating verb.
    const item = COMMANDS.find((c) => c.command.startsWith('kubectl rollout status'))!;
    expect(classifyRisk(item.command)).toBe('mutate');
    expect(riskOf(item)).toBe('read');
  });

  it('falls back to classification when no override is set', () => {
    const item = COMMANDS.find((c) => c.command === 'kubectl get pods')!;
    expect(riskOf(item)).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

describe('extractPlaceholders', () => {
  it('finds each placeholder once, in order', () => {
    expect(extractPlaceholders('kubectl logs <pod-name> -c <container-name> -n <namespace>'))
      .toEqual(['pod-name', 'container-name', 'namespace']);
  });

  it('de-duplicates a placeholder used twice', () => {
    expect(extractPlaceholders('kubectl x <a> <b> <a>')).toEqual(['a', 'b']);
  });

  it('returns nothing for a concrete command', () => {
    expect(extractPlaceholders('kubectl get pods -A')).toEqual([]);
  });

  it('does not mistake jsonpath braces or comparisons for placeholders', () => {
    expect(extractPlaceholders('kubectl get pods -o jsonpath="{.items[*].metadata.name}"')).toEqual([]);
    expect(extractPlaceholders('kubectl get pods | grep -v Running')).toEqual([]);
  });
});

describe('fillPlaceholders', () => {
  it('substitutes provided values and leaves the rest alone', () => {
    const out = fillPlaceholders('kubectl logs <pod-name> -c <container-name>', { 'pod-name': 'web-1' });
    expect(out).toBe('kubectl logs web-1 -c <container-name>');
  });

  it('treats blank and whitespace-only values as unfilled', () => {
    expect(fillPlaceholders('kubectl logs <pod-name>', { 'pod-name': '   ' })).toBe('kubectl logs <pod-name>');
  });

  it('replaces every occurrence of a repeated placeholder', () => {
    expect(fillPlaceholders('a <x> b <x>', { x: '1' })).toBe('a 1 b 1');
  });

  it('reports resolution correctly', () => {
    expect(isFullyResolved('kubectl get pods')).toBe(true);
    expect(isFullyResolved('kubectl logs <pod-name>')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The execution gate
// ---------------------------------------------------------------------------

describe('hasShellSideEffects', () => {
  it('detects redirection, pipes, chaining and substitution', () => {
    for (const c of ['kubectl get po > out.yaml', 'kubectl get po | grep x', 'kubectl get po; rm -rf /', 'kubectl get po && reboot', 'echo `whoami`', 'kubectl get po $(id)']) {
      expect(hasShellSideEffects(c), c).toBe(true);
    }
  });

  it('leaves ordinary commands alone', () => {
    expect(hasShellSideEffects('kubectl get pods -A -o wide')).toBe(false);
  });
});

describe('canRun — the gate before Kalam touches a live cluster', () => {
  it('allows a resolved, read-only, metacharacter-free command', () => {
    expect(canRun('kubectl get pods -A -o wide')).toEqual({ runnable: true });
  });

  it('refuses anything that changes state', () => {
    const r = canRun('kubectl delete pod web-1');
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/read-only/i);
  });

  it('refuses a command with unfilled placeholders, naming them', () => {
    const r = canRun('kubectl logs <pod-name> -c <container-name>');
    expect(r.runnable).toBe(false);
    expect(r.reason).toContain('<pod-name>');
    expect(r.reason).toContain('<container-name>');
  });

  it('refuses shell redirection even when the kubectl part is read-only', () => {
    const r = canRun('kubectl get pods -o yaml > pods.yaml');
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/redirection|chaining/i);
  });

  it('refuses a piped read command — the pipe could run anything', () => {
    expect(canRun('kubectl get pods -A | grep -v Running').runnable).toBe(false);
  });

  it('fails closed: no catalog command that mutates is ever runnable', () => {
    for (const item of COMMANDS) {
      if (riskOf(item) !== 'read') {
        expect(canRun(item.command).runnable, item.command).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------

describe('command catalog', () => {
  it('has no duplicate commands', () => {
    const seen = new Set<string>();
    for (const c of COMMANDS) {
      expect(seen.has(c.command), `duplicate: ${c.command}`).toBe(false);
      seen.add(c.command);
    }
  });

  it('gives every command a description, a category and at least one tag', () => {
    for (const c of COMMANDS) {
      expect(c.description.length, c.command).toBeGreaterThan(10);
      expect(c.tags.length, c.command).toBeGreaterThan(0);
      expect(c.category, c.command).toBeTruthy();
    }
  });

  it('starts every command with kubectl', () => {
    for (const c of COMMANDS) expect(c.command.startsWith('kubectl '), c.command).toBe(true);
  });

  it('counts categories consistently with the catalog size', () => {
    const counts = categoryCounts(COMMANDS);
    expect(counts.all).toBe(COMMANDS.length);
    const summed = Object.entries(counts).filter(([k]) => k !== 'all').reduce((a, [, v]) => a + v, 0);
    expect(summed).toBe(COMMANDS.length);
  });
});

describe('searchCommands', () => {
  it('returns everything for an empty query', () => {
    expect(searchCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
  });

  it('requires every term to match (AND, not OR)', () => {
    const both = searchCommands(COMMANDS, 'logs previous');
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((c) => /logs/i.test(c.command + c.description + c.explanation))).toBe(true);
    expect(both.length).toBeLessThan(searchCommands(COMMANDS, 'logs').length);
  });

  it('searches descriptions and explanations, not just the command text', () => {
    const hits = searchCommands(COMMANDS, 'oomkilled');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(searchCommands(COMMANDS, 'DRAIN').length).toBe(searchCommands(COMMANDS, 'drain').length);
  });

  it('combines with a category filter', () => {
    const hits = searchCommands(COMMANDS, '', 'security');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((c) => c.category === 'security')).toBe(true);
  });

  it('returns nothing for nonsense', () => {
    expect(searchCommands(COMMANDS, 'zzzznotacommand')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

describe('buildCommand', () => {
  it('builds the default listing', () => {
    expect(buildCommand(builder())).toBe('kubectl get pods');
  });

  it('applies namespace scope', () => {
    expect(buildCommand(builder({ namespaceOpt: 'all' }))).toBe('kubectl get pods -A');
    expect(buildCommand(builder({ namespaceOpt: 'specific', namespace: 'ezmeral' }))).toBe('kubectl get pods -n ezmeral');
    // "specific" with nothing typed must not emit a dangling -n.
    expect(buildCommand(builder({ namespaceOpt: 'specific', namespace: '  ' }))).toBe('kubectl get pods');
  });

  it('adds output format, sorting and watch', () => {
    expect(buildCommand(builder({ format: 'wide' }))).toBe('kubectl get pods -o wide');
    expect(buildCommand(builder({ format: 'jsonpath', jsonpath: '{.items[*].metadata.name}' })))
      .toBe('kubectl get pods -o jsonpath="{.items[*].metadata.name}"');
    expect(buildCommand(builder({ sortBy: '.status.startTime', watch: true })))
      .toBe('kubectl get pods --sort-by=.status.startTime --watch');
  });

  it('uses a label selector only when no name is given', () => {
    expect(buildCommand(builder({ selector: 'app=web' }))).toBe('kubectl get pods -l app=web');
    expect(buildCommand(builder({ selector: 'app=web', name: 'web-1' }))).toBe('kubectl get pods web-1');
  });

  it('builds a real logs command instead of a bare stub', () => {
    const cmd = buildCommand(builder({ verb: 'logs', name: 'web-1', container: 'app', previous: true, tail: '50', follow: false }));
    expect(cmd).toBe('kubectl logs web-1 -c app --previous --tail=50');
  });

  it('omits --tail when full logs are requested', () => {
    expect(buildCommand(builder({ verb: 'logs', name: 'web-1', tail: 'all' }))).toBe('kubectl logs web-1');
  });

  it('builds exec with -it and a -- separator', () => {
    expect(buildCommand(builder({ verb: 'exec', name: 'web-1', execCommand: '/bin/sh' })))
      .toBe('kubectl exec -it web-1 -- /bin/sh');
    expect(buildCommand(builder({ verb: 'exec', name: 'web-1', container: 'app', execCommand: 'env' })))
      .toBe('kubectl exec -it web-1 -c app -- env');
  });

  it('scales to the replica count actually chosen, not a hardcoded 3', () => {
    expect(buildCommand(builder({ verb: 'scale', resource: 'deployments', name: 'api', replicas: '7' })))
      .toBe('kubectl scale deployments/api --replicas=7');
    expect(buildCommand(builder({ verb: 'scale', resource: 'deployments', name: 'api', replicas: '0' })))
      .toBe('kubectl scale deployments/api --replicas=0');
  });

  it('builds rollout subcommands against the right object', () => {
    expect(buildCommand(builder({ verb: 'rollout', rolloutAction: 'undo', resource: 'deployments', name: 'api' })))
      .toBe('kubectl rollout undo deployments/api');
  });

  it('maps port-forward onto svc/ or pod/', () => {
    expect(buildCommand(builder({ verb: 'port-forward', resource: 'services', name: 'api', localPort: '8080', remotePort: '80' })))
      .toBe('kubectl port-forward svc/api 8080:80');
    expect(buildCommand(builder({ verb: 'port-forward', resource: 'pods', name: 'web-1', localPort: '9000', remotePort: '9000' })))
      .toBe('kubectl port-forward pod/web-1 9000:9000');
  });

  it('adds force flags and dry-run to delete', () => {
    expect(buildCommand(builder({ verb: 'delete', resource: 'pods', name: 'web-1', force: true })))
      .toBe('kubectl delete pods web-1 --force --grace-period=0');
  });

  it('never emits double spaces or a trailing space', () => {
    const states = [
      builder(), builder({ verb: 'logs', name: 'a' }), builder({ verb: 'exec', name: 'a' }),
      builder({ verb: 'delete' }), builder({ verb: 'scale', name: 'a' }),
      builder({ verb: 'rollout', name: 'a' }), builder({ verb: 'port-forward', name: 'a' }),
      builder({ verb: 'top', resource: 'nodes' }), builder({ verb: 'describe', name: 'a' }),
    ];
    for (const s of states) {
      const cmd = buildCommand(s);
      expect(cmd, JSON.stringify(s.verb)).not.toMatch(/\s{2,}/);
      expect(cmd).toBe(cmd.trim());
    }
  });

  it('produces a command the risk classifier agrees with', () => {
    expect(classifyRisk(buildCommand(builder()))).toBe('read');
    expect(classifyRisk(buildCommand(builder({ verb: 'delete', name: 'a' })))).toBe('destructive');
  });
});

describe('validateBuilder', () => {
  const messages = (s: BuilderState) => validateBuilder(s).map((i) => i.message).join(' | ');

  it('accepts a sane default', () => {
    expect(validateBuilder(builder())).toEqual([]);
  });

  it('rejects -A combined with a specific name', () => {
    const issues = validateBuilder(builder({ namespaceOpt: 'all', name: 'web-1' }));
    expect(issues.some((i) => i.level === 'error' && /-A cannot be combined/.test(i.message))).toBe(true);
  });

  it('requires a name for verbs that cannot work without one', () => {
    for (const verb of ['logs', 'exec', 'scale', 'port-forward'] as const) {
      expect(messages(builder({ verb })), verb).toMatch(/needs a specific resource name/);
    }
  });

  it('warns loudly before a namespace-wide delete', () => {
    expect(messages(builder({ verb: 'delete' }))).toMatch(/deletes EVERY/);
    // Naming one object clears the warning.
    expect(messages(builder({ verb: 'delete', name: 'web-1' }))).not.toMatch(/deletes EVERY/);
  });

  it('explains what force delete really does', () => {
    expect(messages(builder({ verb: 'delete', name: 'web-1', force: true }))).toMatch(/orphaned processes/);
  });

  it('flags a non-numeric replica count as an error', () => {
    expect(validateBuilder(builder({ verb: 'scale', name: 'a', replicas: 'three' })).some((i) => i.level === 'error')).toBe(true);
    expect(validateBuilder(builder({ verb: 'scale', name: 'a', replicas: '0' })).some((i) => i.level === 'error')).toBe(false);
  });

  it('notes that scaling to zero stops the workload', () => {
    expect(messages(builder({ verb: 'scale', name: 'a', replicas: '0' }))).toMatch(/stops the workload/);
  });

  it('rejects kubectl top on unsupported resources', () => {
    expect(messages(builder({ verb: 'top', resource: 'services' }))).toMatch(/only supports pods and nodes/);
    expect(validateBuilder(builder({ verb: 'top', resource: 'nodes' }))).toEqual([]);
  });

  it('points out that --previous and --follow contradict each other', () => {
    expect(messages(builder({ verb: 'logs', name: 'a', previous: true, follow: true }))).toMatch(/nothing left to follow/);
  });

  it('points out that a selector is ignored once a name is given', () => {
    expect(messages(builder({ selector: 'app=web', name: 'web-1' }))).toMatch(/ignored once you name/);
  });

  it('requires an expression for jsonpath output', () => {
    expect(validateBuilder(builder({ format: 'jsonpath', jsonpath: '' })).some((i) => i.level === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runbooks and quiz
// ---------------------------------------------------------------------------

describe('runbooks', () => {
  it('has unique ids', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it('numbers steps sequentially from 1 and explains each one', () => {
    for (const s of SCENARIOS) {
      expect(s.steps.length, s.id).toBeGreaterThan(2);
      s.steps.forEach((step, i) => {
        expect(step.step, `${s.id} step ${i}`).toBe(i + 1);
        expect(step.notes.length, `${s.id} step ${i}`).toBeGreaterThan(20);
        expect(step.cmd.length, `${s.id} step ${i}`).toBeGreaterThan(0);
      });
    }
  });

  it('describes the symptom so a runbook is findable from the error', () => {
    for (const s of SCENARIOS) expect(s.symptom.length, s.id).toBeGreaterThan(15);
  });
});

describe('quiz', () => {
  it('has a valid, in-range answer and an explanation for every question', () => {
    for (const q of QUIZ_QUESTIONS) {
      expect(q.options.length, q.question).toBeGreaterThanOrEqual(3);
      expect(q.correct).toBeGreaterThanOrEqual(0);
      expect(q.correct).toBeLessThan(q.options.length);
      expect(q.explanation.length, q.question).toBeGreaterThan(30);
      expect(new Set(q.options).size, `duplicate options in: ${q.question}`).toBe(q.options.length);
    }
  });

  it('shuffles without losing or duplicating items', () => {
    const seq = [0.9, 0.1, 0.5, 0.2, 0.7, 0.3];
    let i = 0;
    const shuffled = shuffle([1, 2, 3, 4, 5, 6], () => seq[i++ % seq.length]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('leaves the source array untouched', () => {
    const src = [1, 2, 3];
    shuffle(src, () => 0.5);
    expect(src).toEqual([1, 2, 3]);
  });

  it('picks the requested number of distinct questions', () => {
    const picked = pickQuiz(8, () => 0.5);
    expect(picked).toHaveLength(8);
    expect(new Set(picked.map((q) => q.question)).size).toBe(8);
  });

  it('never asks for more questions than exist', () => {
    expect(pickQuiz(999, () => 0.5)).toHaveLength(QUIZ_QUESTIONS.length);
  });
});
