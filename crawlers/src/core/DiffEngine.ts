import { CrawledData, ChangeEvent, ChangeType } from '../models/types.js';
import { DataType } from '../utils/storage.js';

export interface DiffOptions {
  /**
   * Emit 'removed' events for items present before but absent now.
   * Only enable for sources where each crawl is a complete snapshot
   * (e.g. job boards). Query-based crawls (trials, papers) return
   * partial sets, where absence does not mean removal.
   */
  detectRemovals?: boolean;
}

/**
 * Fields whose changes are significant enough to emit an 'updated' event.
 * Everything else (crawledAt, description tweaks, citation counts) is
 * persisted via upsert but does not generate noise in the change log.
 */
const SIGNIFICANT_FIELDS: Partial<Record<DataType, string[]>> = {
  clinical_trials: ['status', 'phase', 'enrollment', 'completionDate', 'primaryCompletionDate'],
  companies: ['stage', 'ticker', 'type'],
  jobs: ['title'],
  people: ['organization', 'title', 'role'],
  events: ['startDate', 'endDate'],
  educational_resources: []
};

const ENTITY_LABELS: Record<DataType, string> = {
  clinical_trials: 'clinical trial',
  research_papers: 'research paper',
  companies: 'company',
  people: 'person',
  jobs: 'job posting',
  events: 'event',
  educational_resources: 'educational resource'
};

/**
 * Compares the previous stored state with a fresh crawl result and emits
 * typed change events: the raw material for alerts, the weekly newsletter,
 * and API webhooks.
 */
export class DiffEngine {
  diff(
    type: DataType,
    previous: CrawledData[],
    current: CrawledData[],
    options: DiffOptions = {}
  ): ChangeEvent[] {
    const events: ChangeEvent[] = [];
    const detectedAt = new Date().toISOString();
    const previousById = new Map(previous.map(item => [item.id, item]));
    const currentIds = new Set(current.map(item => item.id));

    for (const item of current) {
      const before = previousById.get(item.id);

      if (!before) {
        events.push(this.buildEvent(type, item, 'added', detectedAt));
        continue;
      }

      const changedFields = this.changedFields(type, before, item);
      if (changedFields.length > 0) {
        events.push(this.buildEvent(type, item, 'updated', detectedAt, changedFields));
      }
    }

    if (options.detectRemovals) {
      for (const item of previous) {
        if (!currentIds.has(item.id)) {
          events.push(this.buildEvent(type, item, 'removed', detectedAt));
        }
      }
    }

    return events;
  }

  private changedFields(
    type: DataType,
    before: CrawledData,
    after: CrawledData
  ): NonNullable<ChangeEvent['fields']> {
    const fields = SIGNIFICANT_FIELDS[type] ?? [];
    const changes: NonNullable<ChangeEvent['fields']> = [];

    for (const field of fields) {
      const from = this.stringify((before as Record<string, unknown>)[field]);
      const to = this.stringify((after as Record<string, unknown>)[field]);

      if (from !== to) {
        changes.push({ field, from, to });
      }
    }

    return changes;
  }

  private stringify(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private buildEvent(
    type: DataType,
    item: CrawledData,
    changeType: ChangeType,
    detectedAt: string,
    fields?: ChangeEvent['fields']
  ): ChangeEvent {
    const title = this.titleOf(item);

    return {
      id: `chg_${type}_${item.id}_${changeType}_${detectedAt}`,
      entityType: type,
      entityId: item.id,
      entityTitle: title,
      changeType,
      fields,
      summary: this.summarize(type, title, changeType, fields),
      detectedAt
    };
  }

  private titleOf(item: CrawledData): string {
    if ('title' in item && typeof item.title === 'string') return item.title;
    if ('name' in item && typeof item.name === 'string') return item.name;
    return item.id;
  }

  private summarize(
    type: DataType,
    title: string,
    changeType: ChangeType,
    fields?: ChangeEvent['fields']
  ): string {
    const label = ENTITY_LABELS[type];

    switch (changeType) {
      case 'added':
        return `New ${label}: ${title}`;
      case 'removed':
        return `${capitalize(label)} removed: ${title}`;
      case 'updated': {
        const details = (fields ?? [])
          .map(f => `${f.field} ${f.from ?? '(none)'} → ${f.to ?? '(none)'}`)
          .join(', ');
        return `${capitalize(label)} updated: ${title}${details ? ` (${details})` : ''}`;
      }
    }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
