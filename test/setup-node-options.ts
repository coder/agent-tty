const NODE_OPTIONS_DISABLE_DEP0205 = '--disable-warning=DEP0205';

const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
const nodeOptions = existingNodeOptions
  .split(/\s+/u)
  .filter((option) => option.length > 0);

if (!nodeOptions.includes(NODE_OPTIONS_DISABLE_DEP0205)) {
  process.env.NODE_OPTIONS = [
    ...nodeOptions,
    NODE_OPTIONS_DISABLE_DEP0205,
  ].join(' ');
}
