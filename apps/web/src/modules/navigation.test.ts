import { describe, expect, it } from 'vitest';
import { activePanel, groupNavItems, PANELS } from './registry';
describe('workspace navigation', () => {
 it('places each existing route in exactly one group without dropping entries', () => {
  const ids=groupNavItems().flatMap(g=>g.items.map(i=>i.id));
  expect(ids.length).toBe(PANELS.length); expect(new Set(ids).size).toBe(PANELS.length);
  expect([...ids].sort()).toEqual(PANELS.map(i=>i.id).sort());
 });
 it('keeps ETF observation separate from trading management', () => {
  expect(groupNavItems().find(g=>g.id==='observe')?.items.map(i=>i.id)).toContain('etf-volume');
  expect(groupNavItems().find(g=>g.id==='manage')?.items.map(i=>i.id)).toEqual(expect.arrayContaining(['orders','trend','settings']));
 });
 it('matches nested pages but not same-prefix siblings', () => {
  expect(activePanel('/quotes/detail')?.id).toBe('quotes');
  expect(activePanel('/quotes-other')).toBeUndefined();
  expect(activePanel('/')).toBeUndefined();
 });
 it('does not mutate the source registry', () => {
  const before=JSON.stringify(PANELS); groupNavItems(); expect(JSON.stringify(PANELS)).toBe(before);
 });
});
