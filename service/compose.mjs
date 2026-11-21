const sources = {
  models: ['model/list', () => ({limit:100}), r => r.data.filter(m => !m.hidden).map(m => ({
    id:m.model, name:m.displayName, efforts:m.supportedReasoningEfforts,
    image:m.inputModalities.includes('image')
  }))],
  skills: ['skills/list', cwd => ({cwds:[cwd]}), r => r.data.flatMap(entry => entry.skills)
    .filter(s => s.enabled).map(s => ({id:s.path,name:s.name,description:s.shortDescription || s.description}))],
  plugins: ['plugin/installed', cwd => ({cwds:[cwd]}), r => r.marketplaces.flatMap(m => m.plugins)
    .filter(p => p.installed).map(p => ({id:p.id,name:p.interface?.displayName || p.name,enabled:p.enabled}))],
  permissions: ['permissionProfile/list', cwd => ({cwd}), r => r.data]
};

export async function composeCatalog(rpc, cwd, keys = Object.keys(sources)) {
  const results = await Promise.allSettled(keys.map(async key => {
    const [method, params, convert] = sources[key];
    const list = convert(await rpc.call(method,params(cwd)));
    return [...new Map(list.map(item => [item.id,item])).values()];
  }));
  const errors = {};
  const catalog = {};
  for (const [index,result] of results.entries()) {
    const key = keys[index];
    catalog[key] = result.status === 'fulfilled' ? result.value : [];
    if (result.status === 'rejected') errors[key] = result.reason.message;
  }
  return {...catalog,errors};
}

export async function turnOptions(rpc, cwd, options, attachments = []) {
  const {model, effort, skill, permissions, disabledPlugins} = options || {};
  const keys = [];
  if (model || effort) keys.push('models');
  if (skill) keys.push('skills');
  if (permissions) keys.push('permissions');
  if (disabledPlugins !== undefined) keys.push('plugins');
  if (!keys.length) return {overrides:{}};
  const catalogs = await composeCatalog(rpc,cwd,keys);
  if (Object.keys(catalogs.errors).length) throw Error('无法核对 Codex 选项：'+Object.values(catalogs.errors).join('；'));
  const overrides = {};
  if (model) {
    const entry = catalogs.models.find(m => m.id === model);
    if (!entry) throw Error('该模型不可用');
    if (effort && !entry.efforts.some(o => o.reasoningEffort === effort)) throw Error('该模型不支持所选推理强度');
    if (!entry.image && attachments.some(file => file.image)) throw Error('该模型不支持图片输入');
    overrides.model = entry.id;
    if (effort) overrides.effort = effort;
  } else if (effort) throw Error('请先选择模型');
  const chosenSkill = skill && catalogs.skills.find(s => s.id === skill);
  if (skill && !chosenSkill) throw Error('当前工作目录中找不到所选 Skill');
  if (permissions) {
    if (!catalogs.permissions.some(p => p.id === permissions && p.allowed)) throw Error('当前 Codex 策略不允许所选权限');
    overrides.permissions = permissions;
  }
  if (disabledPlugins !== undefined) {
    if (!Array.isArray(disabledPlugins) || disabledPlugins.some(id => !catalogs.plugins.some(p => p.id === id && p.enabled))) {
      throw Error('所选插件配置已失效');
    }
    overrides.disabledPluginIds = [...new Set(disabledPlugins)];
  }
  return {overrides, skill:chosenSkill};
}
