import { cssVar } from '@toeverything/theme';
import { globalStyle, style } from '@vanilla-extract/css';

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '0 24px',
  gap: 16,
});
export const headerTitle = style({
  fontSize: 15,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
});
export const body = style({
  height: '100%',
  overflow: 'auto',
  padding: '24px 32px',
  color: cssVar('textPrimaryColor'),
  '@media': { 'screen and (max-width: 700px)': { padding: '16px' } },
});
export const intro = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  marginBottom: 22,
});
export const heading = style({
  fontSize: 24,
  fontWeight: 600,
  margin: '0 0 7px',
  letterSpacing: '-.4px',
});
export const muted = style({
  color: cssVar('textSecondaryColor'),
  fontSize: 12,
  lineHeight: 1.6,
  margin: 0,
});
export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  paddingBottom: 18,
  borderBottom: `1px solid ${cssVar('borderColor')}`,
});
export const tabs = style({ display: 'flex', gap: 4, flexWrap: 'wrap' });
export const active = style({
  background: cssVar('hoverColor'),
  color: cssVar('primaryColor'),
});
export const control = style({
  border: `1px solid ${cssVar('borderColor')}`,
  background: cssVar('backgroundPrimaryColor'),
  color: cssVar('textPrimaryColor'),
  borderRadius: 6,
  padding: '7px 10px',
  font: 'inherit',
  fontSize: 12,
  minHeight: 32,
  minWidth: 0,
  ':focus-visible': {
    outline: `2px solid ${cssVar('primaryColor')}`,
    outlineOffset: 1,
  },
});
export const search = style([control, { flex: '1 1 180px', maxWidth: 300 }]);
export const summary = style({
  display: 'flex',
  gap: 20,
  flexWrap: 'wrap',
  fontSize: 12,
  color: cssVar('textSecondaryColor'),
  padding: '17px 0',
});
export const tableWrap = style({
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 8,
  overflowX: 'auto',
});
export const table = style({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  minWidth: 640,
});
globalStyle(`${table} th`, {
  textAlign: 'left',
  fontWeight: 500,
  fontSize: 11,
  color: cssVar('textSecondaryColor'),
  background: cssVar('backgroundSecondaryColor'),
  padding: '11px 14px',
});
globalStyle(`${table} td`, {
  padding: '13px 14px',
  borderTop: `1px solid ${cssVar('borderColor')}`,
});
export const titleButton = style({
  border: 0,
  background: 'none',
  padding: 0,
  color: cssVar('textPrimaryColor'),
  font: 'inherit',
  fontWeight: 500,
  textAlign: 'left',
  cursor: 'pointer',
  ':hover': { color: cssVar('primaryColor') },
  ':focus-visible': { outline: `2px solid ${cssVar('primaryColor')}` },
});
export const status = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 12,
  whiteSpace: 'nowrap',
});
export const dot = style({
  width: 7,
  height: 7,
  borderRadius: '50%',
  display: 'inline-block',
  background: cssVar('textSecondaryColor'),
});
export const board = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(7,minmax(210px,1fr))',
  gap: 12,
  overflowX: 'auto',
  paddingBottom: 18,
});
export const column = style({
  padding: 10,
  borderRadius: 8,
  background: cssVar('backgroundSecondaryColor'),
  minHeight: 260,
});
export const columnHead = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontWeight: 500,
  fontSize: 12,
  padding: '3px 3px 12px',
});
export const card = style({
  width: '100%',
  textAlign: 'left',
  background: cssVar('backgroundPrimaryColor'),
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 7,
  padding: 12,
  marginBottom: 8,
  color: cssVar('textPrimaryColor'),
  font: 'inherit',
  cursor: 'pointer',
  ':hover': { borderColor: cssVar('primaryColor') },
  ':focus-visible': { outline: `2px solid ${cssVar('primaryColor')}` },
});
export const cardTitle = style({
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.6,
  margin: '0 0 12px',
  overflowWrap: 'anywhere',
});
export const cardMeta = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  color: cssVar('textSecondaryColor'),
  gap: 8,
});
export const empty = style({
  padding: '45px 20px',
  textAlign: 'center',
  border: `1px dashed ${cssVar('borderColor')}`,
  borderRadius: 8,
  color: cssVar('textSecondaryColor'),
});
export const alert = style({
  padding: 12,
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 6,
  margin: '12px 0',
  fontSize: 12,
  lineHeight: 1.6,
  background: cssVar('backgroundSecondaryColor'),
});
export const form = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
});
export const field = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  fontSize: 12,
  color: cssVar('textSecondaryColor'),
});
export const grid = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 14,
  '@media': { 'screen and (max-width: 600px)': { gridTemplateColumns: '1fr' } },
});
export const actions = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  paddingTop: 15,
  borderTop: `1px solid ${cssVar('borderColor')}`,
});
export const actionGroup = style({
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  flexWrap: 'wrap',
});
export const section = style({
  borderTop: `1px solid ${cssVar('borderColor')}`,
  paddingTop: 16,
  marginTop: 16,
});
export const sectionHeading = style({
  fontSize: 13,
  fontWeight: 600,
  margin: '0 0 10px',
});
export const linked = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '7px 0',
});
export const activity = style({
  margin: 0,
  padding: '0 0 0 18px',
  maxHeight: 180,
  overflow: 'auto',
});
globalStyle(`${activity} li`, {
  fontSize: 12,
  lineHeight: 1.6,
  marginBottom: 8,
});
export const editorNote = style({
  background: cssVar('backgroundSecondaryColor'),
  padding: 12,
  borderRadius: 7,
  fontSize: 12,
  lineHeight: 1.6,
  color: cssVar('textSecondaryColor'),
});

export const dependencyScroll = style({
  overflow: 'auto',
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 8,
  padding: 12,
});
export const dependencyLines = style({
  position: 'absolute',
  inset: 0,
  color: cssVar('textSecondaryColor'),
  pointerEvents: 'none',
});
export const dependencyNode = style({
  position: 'absolute',
  width: 244,
  height: 98,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  textAlign: 'left',
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 8,
  background: cssVar('backgroundPrimaryColor'),
  color: cssVar('textPrimaryColor'),
  fontSize: 12,
  cursor: 'pointer',
  overflowWrap: 'anywhere',
  ':focus-visible': {
    outline: `2px solid ${cssVar('primaryColor')}`,
    outlineOffset: 2,
  },
});

globalStyle(`${dependencyNode} strong`, {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
});
