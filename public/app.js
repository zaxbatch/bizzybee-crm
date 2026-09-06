'use strict';

/* ============================ Helpers ============================ */

const $ = (sel) => document.querySelector(sel);
const viewEl = () => $('#view');

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n || 0));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${isError ? 'error' : ''}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ============================ Plan / subscription ============================ */

let accountInfo = null;
let customFields = [];

function fmtLimit(v) {
  return v === 'unlimited' ? 'Unlimited' : Number(v).toLocaleString();
}

function featureLabel(features, key) {
  switch (key) {
    case 'api': return features.api === 'full' ? '✓ Full Access' : (features.api ? '✓' : '—');
    case 'whiteLabel': return features.whiteLabel ? '✓ Full rebranding + custom domain' : '—';
    case 'prioritySupport': return features.prioritySupport ? '✓ 1–4hr response, dedicated queue' : '—';
    case 'workflow': return features.workflow === 'none' ? '—' : (features.workflow === 'basic' ? 'Basic' : 'Advanced');
    case 'reports': return features.reports === 'basic' ? 'Basic' : (features.reports === 'custom' ? 'Custom Reports' : 'Advanced + AI Insights');
    default: return '—';
  }
}

async function loadAccount() {
  try {
    accountInfo = await api('GET', '/api/account');
    renderPlan();
  } catch { /* plan badge stays on its default */ }
}

async function loadCustomFields() {
  try {
    customFields = await api('GET', '/api/custom-fields');
  } catch { /* keep whatever we had */ }
}

function renderPlan() {
  if (!accountInfo) return;
  const { plan, usage } = accountInfo;
  $('#planBadge').textContent = plan.name;
  const limit = fmtLimit(plan.limits.contacts);
  $('#planUsage').textContent = limit === 'Unlimited'
    ? 'Unlimited contacts'
    : `${usage.contacts.toLocaleString()} / ${limit} contacts`;
}

/* ============================ Custom fields ============================ */

async function renderCustomFields(el) {
  const limit = accountInfo ? accountInfo.plan.limits.customFields : 0;
  const locked = limit === 0;

  let bodyHtml;
  if (locked) {
    bodyHtml = '<div class="empty" style="text-align:center;padding:28px;">' +
      '<p>Custom fields are a <strong>Pro</strong> feature (up to 50) — <strong>Business</strong> gets unlimited.</p>' +
      '<p style="margin-top:10px;"><button class="btn btn-primary" data-upgrade>Upgrade plan</button></p></div>';
  } else if (customFields.length) {
    bodyHtml = '<table><thead><tr><th>Label</th><th>Type</th><th>Options</th><th></th></tr></thead><tbody>' +
      customFields.map((f) => `
              <tr>
                <td><strong>${esc(f.label)}</strong></td>
                <td>${esc(f.type)}</td>
                <td>${esc((f.options || []).join(', ') || '—')}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" data-edit-cf="${esc(f.id)}">Edit</button>
                  <button class="btn btn-danger btn-sm" data-del-cf="${esc(f.id)}">Delete</button>
                </td>
              </tr>`).join('') +
      '</tbody></table>';
  } else {
    bodyHtml = '<div class="empty">No custom fields yet — add your first one. They appear on the contact form.</div>';
  }

  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Custom Fields (${customFields.length}${limit !== 'unlimited' ? ' / ' + limit : ''})</h2>
        <div class="panel-actions">
          ${locked ? '' : '<button class="btn btn-primary btn-sm" data-new-cf>+ New Field</button>'}
        </div>
      </div>
      ${bodyHtml}
    </div>`;

  el.querySelector('[data-new-cf]')?.addEventListener('click', () => customFieldForm(null));
  el.querySelectorAll('[data-edit-cf]').forEach((b) => b.addEventListener('click', () => customFieldForm(customFields.find((f) => f.id === b.dataset.editCf))));
  el.querySelectorAll('[data-del-cf]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this custom field? Its values will be removed from all contacts.')) return;
    try {
      await api('DELETE', '/api/custom-fields/' + b.dataset.delCf);
      customFields = await api('GET', '/api/custom-fields');
      toast('Custom field deleted');
      render();
    } catch (err) { toast(err.message, true); }
  }));
  el.querySelector('[data-upgrade]')?.addEventListener('click', openUpgradeModal);
}

function customFieldForm(field) {
  const isEdit = Boolean(field);
  openModal(isEdit ? 'Edit Custom Field' : 'New Custom Field', `
    <div class="form-grid">
      <div class="full"><label>Label *</label><input name="label" required value="${esc(field?.label || '')}" placeholder="e.g. LinkedIn URL, Lead Source, Founded…" /></div>
      <div class="full"><label>Type</label>
        <select name="type">
          ${['text', 'textarea', 'email', 'url', 'phone', 'number', 'date', 'select', 'checkbox'].map((t) => `<option ${field?.type === t ? 'selected' : ''} value="${t}">${t}</option>`).join('')}
        </select></div>
      <div class="full cf-options" ${field?.type === 'select' ? '' : 'style="display:none"'}>
        <label>Options <span class="opt">(one per line — for dropdowns)</span></label>
        <textarea name="options" rows="4" placeholder="Option 1&#10;Option 2">${esc((field?.options || []).join('\n'))}</textarea>
      </div>
    </div>`);
  $('#modalForm').querySelector('[name=type]').addEventListener('change', (e) => {
    $('#modalForm').querySelector('.cf-options').style.display = e.target.value === 'select' ? '' : 'none';
  });
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const type = fd.get('type');
    const payload = {
      label: fd.get('label'),
      type,
      options: type === 'select' ? String(fd.get('options')).split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
    };
    try {
      if (isEdit) await api('PUT', `/api/custom-fields/${field.id}`, payload);
      else await api('POST', '/api/custom-fields', payload);
      customFields = await api('GET', '/api/custom-fields');
      toast(isEdit ? 'Custom field updated' : 'Custom field created');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

function customInputHtml(f, value) {
  const id = 'cf_' + f.id;
  const label = `<label>${esc(f.label)}</label>`;
  switch (f.type) {
    case 'number': return `<div>${label}<input name="${id}" type="number" value="${esc(value || '')}" /></div>`;
    case 'date': return `<div>${label}<input name="${id}" type="date" value="${esc(value || '')}" /></div>`;
    case 'email': return `<div>${label}<input name="${id}" type="email" value="${esc(value || '')}" placeholder="name@example.com" /></div>`;
    case 'url': return `<div>${label}<input name="${id}" type="url" value="${esc(value || '')}" placeholder="https://…" /></div>`;
    case 'phone': return `<div>${label}<input name="${id}" type="tel" value="${esc(value || '')}" /></div>`;
    case 'textarea': return `<div class="full">${label}<textarea name="${id}" rows="3">${esc(value || '')}</textarea></div>`;
    case 'select': {
      const opts = (f.options || []).map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('');
      return `<div>${label}<select name="${id}"><option value="">—</option>${opts}</select></div>`;
    }
    case 'checkbox': return `<div class="full"><label class="cf-check"><input name="${id}" type="checkbox" ${value === 'true' ? 'checked' : ''} /> ${esc(f.label)}</label></div>`;
    default: return `<div>${label}<input name="${id}" value="${esc(value || '')}" /></div>`;
  }
}

/* ============================ Team ============================ */

let teamInfo = null;
let teamTab = 'members';

async function renderTeam(el) {
  let data;
  try {
    data = await api('GET', '/api/team');
  } catch (err) {
    el.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  teamInfo = data;

  const tabs = [{ id: 'members', label: `Members (${data.members.length})`, show: true }];
  if (data.can.permissions) tabs.push({ id: 'roles', label: 'Roles & privileges', show: true });
  if (data.can.subcategories) tabs.push({ id: 'subcategories', label: 'Subcategories', show: true });
  if (!tabs.some((t) => t.id === teamTab)) teamTab = 'members';

  const tabBar = `
    <div class="team-tabs">
      ${tabs.filter((t) => t.show).map((t) =>
        `<button class="tab-btn ${teamTab === t.id ? 'active' : ''}" data-team-tab="${t.id}">${t.label}</button>`).join('')}
    </div>`;

  let body = '';
  if (teamTab === 'members') body = teamMembersHtml(data);
  else if (teamTab === 'roles') body = teamRolesHtml(data);
  else body = teamSubcategoriesHtml(data);

  el.innerHTML = tabBar + body;
  bindTeamActions(el, data);
}

/* ---------------------- Members tab ---------------------- */

function teamMembersHtml(d) {
  const freeSolo = d.seats.limit === 1;
  const me = d.current;
  const manage = d.can.members;

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>Team Members (${d.seats.usage} of ${d.seats.limit} seat${d.seats.limit === 1 ? '' : 's'} used)</h2>
        <div class="panel-actions">
          ${freeSolo
            ? '<button class="btn btn-primary btn-sm" data-upgrade>Upgrade to invite teammates</button>'
            : (manage ? '<button class="btn btn-primary btn-sm" data-new-member>+ Add Member</button>' : '')}
        </div>
      </div>
      <div class="panel-note">${freeSolo
        ? 'Free includes 1 seat — you. Teams start on <strong>Pro (5 seats)</strong>; Business scales to <strong>7,500</strong>. Seats include the account owner.'
        : `Seats include the account owner. Roles: <strong>Admin</strong> (full control), <strong>Editor</strong> (day-to-day work), <strong>Viewer</strong> (read-only). Assign members to subcategories (Sales, Marketing…) to organize them.`}</div>
      <table>
        <thead><tr>
          <th>Name</th><th>Email</th><th>Role</th><th>Subcategory</th><th>Joined</th>${manage ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${d.members.map((m) => {
            const you = m.id === me.id ? ' <span class="tag you-tag">you</span>' : '';
            let actions = manage ? '<td class="row-actions"></td>' : '';
            if (manage && !m.isOwner) {
              actions = `<td class="row-actions">
                <button class="btn btn-sm" data-edit-member="${esc(m.id)}">Edit</button>
                ${d.can.permissions ? `<button class="btn btn-sm" data-privs-member="${esc(m.id)}" title="Customize this member's privileges">Privileges</button>` : ''}
                <button class="btn btn-danger btn-sm" data-del-member="${esc(m.id)}">Remove</button>
              </td>`;
            } else if (manage && m.isOwner) {
              actions = '<td class="row-actions"><span class="muted small">Owner · full access</span></td>';
            }
            return `<tr>
              <td><strong>${esc(m.name)}</strong>${you}</td>
              <td><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td>
              <td><span class="pill pill-${esc(m.isOwner ? 'owner' : m.role)}">${esc(m.isOwner ? 'Owner' : m.roleLabel)}</span></td>
              <td>${m.subcategoryName ? `<span class="subcat-chip">${esc(m.subcategoryName)}</span>` : '<span class="muted">—</span>'}</td>
              <td>${fmtDate(m.createdAt)}</td>
              ${actions}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${(!manage && !me.isOwner) ? `
      <div class="empty" style="padding:14px;font-size:13px;">Your <strong>${esc(me.roleLabel)}</strong> role can view the team — admins invite, edit roles and manage subcategories.</div>` : ''}`;
}

function teamRoleOptionsHtml(d, selected) {
  return d.roles.map((r) =>
    `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(r.label)} — ${esc(r.blurb)}</option>`).join('');
}

function teamSubcategoryOptionsHtml(d, selectedId) {
  const opts = [...d.subcategories.builtIn, ...d.subcategories.custom];
  return `<option value="">— none —</option>` + opts.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

function memberAddForm(d) {
  openModal('Add Team Member', `
    <div class="form-grid">
      <div class="full"><label>Name *</label><input name="name" required placeholder="Jane Doe" /></div>
      <div class="full"><label>Email *</label><input name="email" type="email" required placeholder="jane@company.com" /></div>
      <div class="full"><label>Temporary password * <span class="opt">(min 8 characters — they can change it later)</span></label>
        <input name="password" type="password" required autocomplete="new-password" /></div>
      <div class="full"><label>Role</label>
        <select name="role">${teamRoleOptionsHtml(d, 'editor')}</select></div>
      <div class="full"><label>Subcategory <span class="opt">(optional — organize your team)</span></label>
        <select name="subcategoryId">${teamSubcategoryOptionsHtml(d, '')}</select></div>
    </div>`);
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/team/members', {
        name: fd.get('name'), email: fd.get('email'), password: fd.get('password'),
        role: fd.get('role'), subcategoryId: fd.get('subcategoryId') || ''
      });
      toast('Member added — share their email + password to log in.');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

function memberEditForm(memberId, d) {
  const m = d.members.find((x) => x.id === memberId);
  if (!m) return;
  openModal(`Edit ${esc(m.name)}`, `
    <div class="form-grid">
      <div class="full"><label>Name</label><input name="name" value="${esc(m.name)}" required /></div>
      <div class="full"><label>Role</label>
        <select name="role">${teamRoleOptionsHtml(d, m.role)}</select>
        <div class="muted" style="margin-top:4px">Changing the role takes effect immediately.</div></div>
      <div class="full"><label>Subcategory</label>
        <select name="subcategoryId">${teamSubcategoryOptionsHtml(d, m.subcategoryId)}</select></div>
    </div>`);
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('PATCH', `/api/team/members/${memberId}`, {
        name: fd.get('name'), role: fd.get('role'), subcategoryId: fd.get('subcategoryId') || ''
      });
      toast('Member updated');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

function memberPrivilegesForm(memberId, d) {
  const m = d.members.find((x) => x.id === memberId);
  if (!m) return;
  const preset = (d.roles.find((r) => r.id === m.role) || {}).permissions || {};
  const ov = m.permissionOverrides || {};

  openModal(`Privileges — ${esc(m.name)}`, `
    <div class="muted" style="margin-bottom:12px;font-size:13px;">
      Personal overrides for <strong>${esc(m.roleLabel)}</strong> ${esc(m.name)}. Boxes below show what they can do today.
      Unticking a box removes a privilege; ticking adds one beyond their role.
    </div>
    <div style="overflow-x:auto">${permissionMatrixHtml(d.catalog, [
      { id: 'member', label: `${esc(m.roleLabel)} · ${esc(m.name)}`, values: Object.fromEntries(
        d.catalog.flatMap((g) => g.items).map((i) => [i.key, Object.prototype.hasOwnProperty.call(ov, i.key) ? ov[i.key] : preset[i.key]])
      ), locked: false }
    ])}</div>`);

  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const overrides = {};
    const matrix = $('#modalForm').querySelector('.perm-matrix');
    if (!matrix) return;
    for (const row of [...matrix.querySelectorAll('tbody tr')]) {
      const key = row.dataset.permKey;
      if (!key) continue;
      const checked = !!row.querySelector('input[type=checkbox]')?.checked;
      if (checked !== !!preset[key]) overrides[key] = checked;
    }
    try {
      await api('PUT', `/api/team/members/${memberId}/permissions`, { permissions: overrides });
      toast('Privileges updated');
      closeModal();
      await refreshMe();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------------------- Roles & privileges tab ---------------------- */

/** Rows-per-privilege permission table. cols: [{id,label,values,locked}]. */
function permissionMatrixHtml(catalog, cols) {
  const head = cols.map((c) => `<th>${c.label}${c.locked ? ' <span class="muted small">(owner)</span>' : ''}</th>`).join('');
  const keys = catalog.flatMap((g) => g.items);
  return `
    <table class="perm-matrix">
      <thead><tr><th>Privilege</th>${head}</tr></thead>
      <tbody>
        ${catalog.map((g) => `
          <tr class="perm-group-row"><td colspan="${cols.length + 1}">${esc(g.title)}</td></tr>
          ${g.items.map((item) => `
            <tr data-perm-key="${esc(item.key)}">
              <td>${esc(item.label)}</td>
              ${cols.map((c) => {
                const checked = !!(c.values && c.values[item.key]);
                const title = c.locked ? 'Only the account owner can change Admin privileges' : '';
                return `<td class="perm-cell">
                  <input type="checkbox" data-col="${esc(c.id)}" data-key="${esc(item.key)}" ${checked ? 'checked' : ''} ${c.locked ? 'disabled' : ''} title="${esc(title)}" />
                </td>`;
              }).join('')}
            </tr>`).join('')}
        `).join('')}
      </tbody>
    </table>`;
}

function teamRolesHtml(d) {
  const adminLocked = !d.current.isOwner;
  const cols = d.roles.map((r) => ({
    id: r.id, label: r.label, values: r.permissions, locked: r.id === 'admin' ? adminLocked : false
  }));
  return `
    <div class="panel">
      <div class="panel-head">
        <h2>Roles &amp; privileges</h2>
        <div class="panel-actions">
          <button class="btn btn-primary btn-sm" id="saveRoleMatrix" disabled>Save changes</button>
        </div>
      </div>
      <div class="panel-note">Role defaults apply to everyone holding the role. ${adminLocked
        ? 'Only the account owner can change what Admins can do.'
        : 'Need finer control? Grant personal overrides to individual members from the Members tab.'}
        The account owner always has full access.</div>
      <div style="overflow-x:auto">${permissionMatrixHtml(d.catalog, cols)}</div>
    </div>`;
}

/* ---------------------- Subcategories tab ---------------------- */

function teamSubcategoriesHtml(d) {
  const sc = d.subcategories;
  const counts = {};
  d.members.forEach((m) => { if (m.subcategoryId) counts[m.subcategoryId] = (counts[m.subcategoryId] || 0) + 1; });
  const unlimited = sc.limit === 'unlimited';
  const full = !unlimited && sc.usage >= sc.limit;
  const countText = (id) => `${counts[id] || 0} member${counts[id] === 1 ? '' : 's'}`;

  const addAction = full
    ? `<button class="btn btn-primary btn-sm" data-upgrade>Upgrade for more${sc.limit === 0 ? '' : ''}</button>`
    : `<button class="btn btn-primary btn-sm" data-add-sub>+ Add Custom</button>`;

  return `
    <div class="panel">
      <div class="panel-head">
        <h2>Subcategories</h2>
        <div class="panel-actions">${addAction}</div>
      </div>
      <div class="panel-note">Subcategories (Sales, Marketing, HR, Finance…) organize your team members.
        Built-ins are included on every plan${sc.limit === 0 ? '' : ` — your plan includes ${unlimited ? 'unlimited' : sc.limit} custom subcategor${sc.limit === 1 ? 'y' : 'ies'}`}.
        ${full ? `You've used all ${sc.usage} of your custom subcategories.` : ''}</div>

      <div style="padding:14px 18px;border-bottom:1px solid var(--border);">
        <div class="muted small" style="margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Built-in</div>
        <div class="subcat-grid">
          ${sc.builtIn.map((s) => `
            <div class="subcat-item">
              <span class="subcat-chip">${esc(s.name)}</span>
              <span class="muted small">${countText(s.id)}</span>
            </div>`).join('')}
        </div>
      </div>

      <div style="padding:14px 18px;">
        <div class="muted small" style="margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Custom (${sc.usage}${unlimited ? '' : ' / ' + sc.limit})</div>
        ${sc.custom.length ? `
        <table>
          <thead><tr><th>Name</th><th>Members</th><th></th></tr></thead>
          <tbody>
            ${sc.custom.map((s) => `
              <tr>
                <td><strong>${esc(s.name)}</strong></td>
                <td>${countText(s.id)}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" data-rename-sub="${esc(s.id)}">Rename</button>
                  <button class="btn btn-danger btn-sm" data-del-sub="${esc(s.id)}">Delete</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty" style="padding:16px;">No custom subcategories yet — add one, then assign members from the Members tab.</div>'}
      </div>
    </div>`;
}

function subcategoryNamePrompt(title, initial, submitLabel, onSave) {
  openModal(title, `
    <div class="form-grid">
      <div class="full"><label>Name</label>
        <input name="name" required maxlength="40" value="${esc(initial || '')}" placeholder="e.g. Customer Success, Legal…" /></div>
    </div>`);
  const btn = $('#modalForm').querySelector('button[type=submit]');
  if (btn) btn.textContent = submitLabel;
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await onSave(String(new FormData(e.target).get('name')).trim());
  });
}

/* ---------------------- Team event wiring ---------------------- */

function bindTeamActions(el, d) {
  el.querySelectorAll('[data-team-tab]').forEach((b) => b.addEventListener('click', () => {
    teamTab = b.dataset.teamTab;
    render();
  }));

  el.querySelector('[data-new-member]')?.addEventListener('click', () => memberAddForm(d));
  el.querySelectorAll('[data-edit-member]').forEach((b) => b.addEventListener('click', () => memberEditForm(b.dataset.editMember, d)));
  el.querySelectorAll('[data-privs-member]').forEach((b) => b.addEventListener('click', () => memberPrivilegesForm(b.dataset.privsMember, d)));
  el.querySelectorAll('[data-del-member]').forEach((b) => b.addEventListener('click', async () => {
    const m = d.members.find((x) => x.id === b.dataset.delMember);
    if (!m) return;
    if (!confirm(`Remove ${m.name} from the team? They will lose access to this workspace.`)) return;
    try {
      await api('DELETE', `/api/team/members/${b.dataset.delMember}`);
      toast('Team member removed');
      render();
    } catch (err) { toast(err.message, true); }
  }));

  // Role matrix: enable Save when something changed.
  const saveRoles = el.querySelector('#saveRoleMatrix');
  if (saveRoles) {
    const changed = () => {
      const dirty = new Set();
      el.querySelectorAll('.perm-matrix input[type=checkbox]:not([disabled])').forEach((cb) => {
        const col = cb.dataset.col;
        const key = cb.dataset.key;
        const preset = (d.roles.find((r) => r.id === col) || {}).permissions || {};
        if (cb.checked !== !!preset[key]) dirty.add(col);
      });
      saveRoles.disabled = dirty.size === 0;
      return [...dirty];
    };
    el.querySelectorAll('.perm-matrix input[type=checkbox]').forEach((cb) => cb.addEventListener('change', changed));
    saveRoles.addEventListener('click', async () => {
      const dirty = changed();
      if (!dirty.length) return;
      const btn = saveRoles;
      btn.disabled = true;
      try {
        for (const roleId of dirty) {
          const perms = {};
          el.querySelectorAll(`.perm-matrix input[type=checkbox][data-col="${roleId}"]`).forEach((cb) => { perms[cb.dataset.key] = cb.checked; });
          await api('PUT', '/api/team/permissions/roles', { role: roleId, permissions: perms });
        }
        toast(`Saved privileges for ${dirty.map((r) => (d.roles.find((x) => x.id === r) || {}).label).join(', ')}`);
        render();
      } catch (err) { toast(err.message, true); }
    });
  }

  el.querySelector('[data-add-sub]')?.addEventListener('click', () => {
    subcategoryNamePrompt('Add custom subcategory', '', 'Add', async (name) => {
      try {
        await api('POST', '/api/team/subcategories', { name });
        toast('Subcategory added');
        closeModal();
        render();
      } catch (err) { toast(err.message, true); }
    });
  });
  el.querySelectorAll('[data-rename-sub]').forEach((b) => b.addEventListener('click', () => {
    const sub = [...d.subcategories.builtIn, ...d.subcategories.custom].find((s) => s.id === b.dataset.renameSub);
    if (!sub) return;
    subcategoryNamePrompt('Rename subcategory', sub.name, 'Rename', async (name) => {
      try {
        await api('PUT', `/api/team/subcategories/${sub.id}`, { name });
        toast('Subcategory renamed');
        closeModal();
        render();
      } catch (err) { toast(err.message, true); }
    });
  }));
  el.querySelectorAll('[data-del-sub]').forEach((b) => b.addEventListener('click', async () => {
    const sub = d.subcategories.custom.find((s) => s.id === b.dataset.delSub);
    if (!sub) return;
    if (!confirm(`Delete the "${sub.name}" subcategory? Members assigned to it will be unassigned.`)) return;
    try {
      await api('DELETE', `/api/team/subcategories/${sub.id}`);
      toast('Subcategory deleted');
      render();
    } catch (err) { toast(err.message, true); }
  }));

  el.querySelector('[data-upgrade]')?.addEventListener('click', openUpgradeModal);
}

function openUpgradeModal() {
  if (!accountInfo) return;
  const currentId = accountInfo.plan.id;
  const cards = accountInfo.plans.map((p) => `
    <div class="tier ${p.id === currentId ? 'current' : ''}">
      <h4>${esc(p.name)}${p.id === currentId ? ' <span class="current-tag">Current</span>' : ''}</h4>
      <div class="price">${p.priceMonthly === 0 ? 'Free' : '$' + p.priceMonthly + '/mo'}</div>
      <ul>
        <li>Contacts: ${fmtLimit(p.limits.contacts)}</li>
        <li>Pipelines: ${fmtLimit(p.limits.pipelines)}</li>
        <li>Custom fields: ${fmtLimit(p.limits.customFields)}</li>
        <li>Team seats: ${fmtLimit(p.limits.seats)}${p.limits.seats === 1 ? ' (you)' : ''}${p.limits.seats > 1 ? ' — incl. owner' : ''}</li>
        <li>Roles &amp; privileges: ${p.features.teams ? '✓ Admin / Editor / Viewer + custom' : '— solo'}</li>
        <li>Custom subcategories: ${fmtLimit(p.limits.subcategories)} ${p.limits.subcategories !== 0 ? '(+ built-ins)' : '(built-ins only)'}</li>
        <li>API: ${featureLabel(p.features, 'api')}</li>
        <li>White-label: ${featureLabel(p.features, 'whiteLabel')}</li>
        <li>Priority support: ${featureLabel(p.features, 'prioritySupport')}</li>
        <li>Workflow automation: ${featureLabel(p.features, 'workflow')}</li>
        <li>Reports: ${featureLabel(p.features, 'reports')}</li>
      </ul>
    </div>`).join('');

  const formHtml = `
    <div class="tier-grid">${cards}</div>
    <div class="form-grid">
      <div class="full">
        <label for="planSelect">Switch plan</label>
        <select id="planSelect">
          ${accountInfo.plans.map((p) => `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${esc(p.name)}${p.priceMonthly ? ' — $' + p.priceMonthly + '/mo' : ''}</option>`).join('')}
        </select>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin:12px 0 0;">Plan switches are open during the preview — billing and access gating land when we ship subscriptions.</p>`;

  openModal('Plans & Upgrade', formHtml);
}

// Attached once (the generic modal is reused across views); the handler reads
// the current DOM at submit time and ignores submissions from other modals.
async function submitPlanChange(e) {
  e.preventDefault();
  if (!$('#planSelect')) return;
  const plan = $('#planSelect').value;
  try {
    const data = await api('PUT', '/api/account/plan', { plan });
    accountInfo = data;
    renderPlan();
    toast(`Plan updated to ${data.plan.name}.`);
    closeModal();
  } catch (err) {
    toast(err.message, true);
  }
}
// openModal replaces the form node, so every open starts with zero listeners.
$('#modalForm').addEventListener('submit', submitPlanChange);

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const STAGE_LABELS = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };

/* ============================ API layer ============================ */

let token = localStorage.getItem('bb_token') || '';

async function api(method, url, body, extraHeaders) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);

  // The dev server restarts on file changes (nodemon), and the live Netlify
  // function can briefly 5xx while a cold start / deploy settles. Retry to
  // ride through both — the register route also handles duplicate accounts.
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      if (attempt < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      // fetch() only rejects on network-level failures (server down, wrong
      // origin, file:// pages, mixed content) — explain instead of the
      // cryptic "Failed to fetch".
      const viaFile = location.protocol === 'file:';
      throw new Error(
        'Can\u2019t reach the BizzyBee server. ' +
        (viaFile
          ? 'You opened this page as a file (file://). Start the server with `npm start` in bizzybee-crm and open http://localhost:3000.'
          : `The request to ${method} ${url} on ${location.origin} failed after retrying — is the server still running? (cd bizzybee-crm && npm start)`)
      );
    }

    // A 401 anywhere except the auth endpoints usually means the session
    // expired — but on the serverless deployment a brief cross-instance
    // consistency window can surface a false 401 right after login, so retry
    // a couple of times before logging the user out.
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      if (attempt < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      clearSession();
      showAuthScreen('Your session has expired. Please log in again.');
      throw new Error('Session expired');
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // Include the server's diagnostic detail (e.g. "failed to initialize").
      const detail = data?.message ? ` — ${data.message}` : '';
      const msg = data?.error ? data.error + detail : `${method} ${url} failed (${res.status})`;
      if (res.status >= 500 && attempt < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw new Error(msg);
    }
    return data;
  }
}

/** Download the authenticated user's data for an entity as a CSV file. */
async function exportCsv(entity) {
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/export/${entity}.csv`, { headers });
    } catch {
      throw new Error('Can\u2019t reach the BizzyBee server — is it running? (cd bizzybee-crm && npm start)');
    }
    if (res.status === 401) {
      clearSession();
      showAuthScreen('Your session has expired. Please log in again.');
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Export failed (${res.status})`);
    }
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${entity}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${entity.charAt(0).toUpperCase() + entity.slice(1)} exported`);
  } catch (err) {
    toast(err.message, true);
  }
}

/** Show import results in the modal (row-level errors, first 50). */
function showImportErrors(errors) {
  const list = errors.slice(0, 50).map((e) => `
    <div class="import-err"><b>Row ${e.row}</b>${e.email ? ` — ${esc(e.email)}` : ''}: ${esc(e.errors.join('; '))}</div>`).join('');
  const more = errors.length > 50 ? `<div class="muted">…and ${errors.length - 50} more</div>` : '';
  openModal('Import errors', `<div class="import-errors">${list}${more}</div>`);
  // The generic modal appends Save/Cancel; keep Save from submitting.
  $('#modalForm').addEventListener('submit', (ev) => ev.preventDefault());
}

/** Import contacts/companies from a CSV file picked by the user. */
async function importCsv(entity) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      toast('Could not read the file: ' + err.message, true);
      return;
    }
    showImportMapping(entity, text);
  };
  input.click();
}

/** Minimal RFC-4180 CSV parser (mirrors the server's). */
function parseCsvText(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

const IMPORT_FIELDS = {
  contacts: ['firstName', 'lastName', 'name', 'email', 'phone', 'title', 'address', 'company', 'status', 'tags', 'notes'],
  companies: ['name', 'industry', 'size', 'website', 'address', 'notes']
};
const IMPORT_LABELS = {
  firstName: 'First name', lastName: 'Last name', name: 'Name', email: 'Email', phone: 'Phone',
  title: 'Title', address: 'Address', company: 'Company', status: 'Status', tags: 'Tags', notes: 'Notes',
  industry: 'Industry', size: 'Size', website: 'Website'
};
const IMPORT_ALIASES = {
  firstName: ['firstname', 'first', 'givenname'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  name: ['name', 'fullname', 'full'],
  email: ['email', 'emailaddress', 'emailaddress2'],
  phone: ['phone', 'phonenumber', 'mobile', 'telephone'],
  title: ['title', 'jobtitle', 'position'],
  address: ['address', 'street', 'location'],
  company: ['company', 'companyname', 'organization'],
  status: ['status'],
  tags: ['tags', 'tag'],
  notes: ['notes', 'note'],
  industry: ['industry'],
  size: ['size', 'companysize'],
  website: ['website', 'url']
};

/** Guess a CRM field for each CSV header ('' when nothing obvious). */
function guessField(header) {
  const n = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    if (aliases.includes(n)) return field;
  }
  return '';
}

/** Field-mapping modal: pick column → field, toggle mandatory, preview, import. */
function showImportMapping(entity, csvText) {
  const rows = parseCsvText(csvText);
  if (!rows || rows.length < 2) {
    toast('CSV must include a header row and at least one data row', true);
    return;
  }
  const headers = rows[0];
  let fields = IMPORT_FIELDS[entity];
  let labels = IMPORT_LABELS;
  let aliases = IMPORT_ALIASES;
  if (entity === 'contacts' && customFields.length) {
    fields = [...fields, ...customFields.map((f) => 'cf:' + f.id)];
    labels = { ...labels, ...Object.fromEntries(customFields.map((f) => ['cf:' + f.id, f.label])) };
    aliases = { ...aliases, ...Object.fromEntries(customFields.map((f) => ['cf:' + f.id, [f.label.toLowerCase().replace(/[^a-z0-9]/g, '')]])) };
  }
  const guessLocal = (header) => {
    const n = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [field, al] of Object.entries(aliases)) if (al.includes(n)) return field;
    return '';
  };
  const guesses = headers.map(guessLocal);

  const preview = `
    <table class="map-preview">
      ${rows.slice(0, 4).map((r, i) =>
        `<tr>${r.map((c) => `<td${i === 0 ? ' class="hdr"' : ''}>${esc(c) || '&nbsp;'}</td>`).join('')}</tr>`).join('')}
    </table>`;

  const mapRows = headers.map((h, i) => `
    <tr data-col="${i}" data-header="${esc(h)}">
      <td class="m-col">${esc(h) || '—'}</td>
      <td class="m-map">
        <select class="m-select" data-field="${i}">
          <option value="">— ignore —</option>
          ${fields.map((f) => `<option value="${f}" ${f === guesses[i] ? 'selected' : ''}>${labels[f]}</option>`).join('')}
        </select>
      </td>
      <td class="m-req"><input type="checkbox" data-req="${i}" ${guesses[i] === 'email' || (entity === 'companies' && guesses[i] === 'name') ? 'checked' : ''} title="Rows missing this field are skipped" /></td>
    </tr>`).join('');

  openModal(`Import ${entity === 'contacts' ? 'Contacts' : 'Companies'}`, `
    <div class="import-map">
      <p class="muted">Detected <b>${rows.length - 1}</b> row(s). Map each CSV column to a CRM field. Tick <b>Req</b> to make a field mandatory — rows missing it are skipped and reported.</p>
      ${preview}
      <table class="map-table">
        <thead><tr><th>CSV column</th><th>Map to field</th><th title="Required — rows missing this field are skipped">Req</th></tr></thead>
        <tbody>${mapRows}</tbody>
      </table>
    </div>`);
  const submitBtn = $('#modalForm').querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = 'Import';

  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const mapping = {};
    const required = [];
    form.querySelectorAll('tr[data-col]').forEach((tr) => {
      const header = tr.dataset.header;
      const field = tr.querySelector('select').value;
      const isReq = tr.querySelector('input[type=checkbox]').checked;
      if (field) {
        mapping[field] = header;
        if (isReq && !required.includes(field)) required.push(field);
      }
    });
    if (!Object.keys(mapping).length) {
      toast('Map at least one column to a field', true);
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Importing…';
    try {
      const data = await api('POST', `/api/import/${entity}`, { csv: csvText, mapping, required });
      const label = entity.charAt(0).toUpperCase() + entity.slice(1);
      let msg = `${label}: imported ${data.imported} row(s).`;
      if (data.companiesCreated) msg += ` Created ${data.companiesCreated} company(ies).`;
      if (data.skipped) msg += ` ${data.skipped} row(s) skipped.`;
      toast(msg, data.skipped > 0);
      closeModal();
      if (data.errors && data.errors.length) showImportErrors(data.errors);
      render();
    } catch (err) {
      toast(err.message, true);
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });
}

/* ============================ Auth ============================ */

let currentUser = null;
let authMode = 'login'; // login | register | forgot | reset

function setAuthForm(html) {
  $('#authForm').innerHTML = html;
  attachReveals($('#authForm'));
}

function passwordField(name, label) {
  return `
    <div>
      <label>${label}</label>
      <div class="pw-wrap">
        <input name="${name}" type="password" required minlength="8" autocomplete="new-password" />
        <button type="button" class="pw-toggle" data-toggle-for="${name}" title="Show password" aria-label="Show password">👁️</button>
      </div>
    </div>`;
}

function authFormHtml(mode, prefill = {}) {
  if (mode === 'login') return `
    <div><label>Email</label><input name="email" type="email" required autocomplete="username" value="${esc(prefill.email || '')}" /></div>
    ${passwordField('password', 'Password')}
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="forgotLink">Forgot password?</button>
      <button type="submit" class="btn btn-primary">Log in</button>
    </div>`;
  if (mode === 'register') return `
    <div><label>Name *</label><input name="name" required autocomplete="name" value="${esc(prefill.name || '')}" /></div>
    <div><label>Email *</label><input name="email" type="email" required autocomplete="username" value="${esc(prefill.email || '')}" /></div>
    <div><label>Phone <span class="opt">(optional)</span></label><input name="phone" type="tel" autocomplete="tel" value="${esc(prefill.phone || '')}" /></div>
    ${passwordField('password', 'Password (8+ characters)')}
    <div class="form-actions"><button type="submit" class="btn btn-primary">Create account</button></div>`;
  if (mode === 'forgot') return `
    <div><label>Account email</label><input name="email" type="email" required autocomplete="username" value="${esc(prefill.email || '')}" /></div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="backToLogin">Back to log in</button>
      <button type="submit" class="btn btn-primary">Send reset token</button>
    </div>`;
  // reset
  return `
    <div><label>Reset token</label><input name="token" required value="${esc(prefill.token || '')}" placeholder="Paste the token from the email (or shown above)" /></div>
    ${passwordField('password', 'New password (8+ characters)')}
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="backToLogin">Back to log in</button>
      <button type="submit" class="btn btn-primary">Reset password</button>
    </div>`;
}

/** Password reveal: eye toggle on every password input in a form. */
function attachReveals(form) {
  form.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = form.querySelector(`[name="${btn.dataset.toggleFor}"]`);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '👁️' : '🙈';
      btn.classList.toggle('revealed', !showing);
    });
  });
}

function setAuthMode(mode, prefill = {}) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authTab === mode));
  $('#authHint').classList.add('hidden');
  setAuthForm(authFormHtml(mode, prefill));
  $('#authForm').querySelector('input')?.focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"]');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (authMode === 'login') {
      const data = await api('POST', '/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
      enterApp(data);
    } else if (authMode === 'register') {
      try {
        const data = await api('POST', '/api/auth/register', { name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), password: fd.get('password') });
        enterApp(data);
      } catch (err) {
        // A retried request may have already created the account — in that
        // case, just log in with the credentials the user just typed.
        if (/already exists/i.test(err.message)) {
          try {
            const data = await api('POST', '/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
            toast('Account already existed — logged you in.');
            enterApp(data);
            return;
          } catch { /* fall through to the original error */ }
        }
        throw err;
      }
    } else if (authMode === 'forgot') {
      const data = await api('POST', '/api/auth/forgot', { email: fd.get('email') });
      if (data.resetToken) {
        // Dev mode: no mailer, so surface the token and jump straight to reset.
        setAuthMode('reset', { token: data.resetToken });
        toast('Reset token generated (no mailer — pasted below). Set a new password.');
      } else {
        toast(data.note || 'If an account exists, a reset token has been generated.');
      }
    } else if (authMode === 'reset') {
      await api('POST', '/api/auth/reset', { token: fd.get('token'), password: fd.get('password') });
      toast('Password reset. Log in with your new password.');
      setAuthMode('login');
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showAuthScreen(hint) {
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  setAuthMode('login');
  if (hint) {
    const h = $('#authHint');
    h.textContent = hint;
    h.classList.remove('hidden');
  }
}

function showApp() {
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  renderUserBox();
  updateUIPermissions();
  loadAccount();
  loadCustomFields();
  navigate('dashboard');
}

/** Does the signed-in user hold a privilege (see /api/team catalog)? */
function can(key) {
  return !!(currentUser && (currentUser.permissions || []).includes(key));
}

/** Re-fetch /api/auth/me — after role/privilege changes your own UI gates update. */
async function refreshMe() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    currentUser = user;
    renderUserBox();
    updateUIPermissions();
  } catch { /* keep whatever we had */ }
}

function renderUserBox() {
  if (!currentUser) return;
  $('#userEmail').textContent = currentUser.email || '';
  const roleEl = $('#userRole');
  if (roleEl) roleEl.textContent = currentUser.roleLabel || '';
}

/** Show/hide nav items, the +Add menu and sidebar role based on privileges. */
function updateUIPermissions() {
  const dataViews = ['dashboard', 'contacts', 'companies', 'deals', 'activities'];
  document.querySelectorAll('.nav-btn').forEach((b) => {
    const v = b.dataset.view;
    const visible = v === 'team' ? true
      : v === 'customfields' ? can('manage.customFields')
        : dataViews.includes(v) ? can('data.view') : true;
    b.classList.toggle('hidden', !visible);
  });
  const canCreate = can('data.create');
  const addBtn = $('#primaryAction');
  if (addBtn) addBtn.classList.toggle('hidden', !canCreate);
  if (!canCreate) $('#addMenu').classList.add('hidden');
  document.querySelectorAll('#addMenu [data-add]').forEach((b) => {
    b.classList.toggle('hidden', !canCreate);
  });
}

function clearSession() {
  token = '';
  localStorage.removeItem('bb_token');
  currentUser = null;
}

function enterApp(data) {
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('bb_token', token);
  toast(`Welcome, ${currentUser.name || currentUser.email}!`);
  showApp();
}

/* ============================ Navigation ============================ */

const VIEWS = ['dashboard', 'contacts', 'companies', 'deals', 'activities', 'team', 'customfields'];
let currentView = 'dashboard';

function setActiveNav(view) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

function navigate(view) {
  currentView = view;
  setActiveNav(view);
  $('#globalSearch').value = '';
  render();
}

async function render() {
  const el = viewEl();
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (currentView === 'dashboard') await renderDashboard(el);
    else if (currentView === 'contacts') await renderContacts(el);
    else if (currentView === 'companies') await renderCompanies(el);
    else if (currentView === 'deals') await renderDeals(el);
    else if (currentView === 'activities') await renderActivities(el);
    else if (currentView === 'customfields') await renderCustomFields(el);
    else if (currentView === 'team') await renderTeam(el);
  } catch (err) {
    el.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
  }
}

/* ============================ Dashboard ============================ */

async function renderDashboard(el) {
  const d = await api('GET', '/api/dashboard');
  const maxStage = Math.max(1, ...d.dealsByStage.map((s) => s.total));

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="label">Contacts</div><div class="value">${d.counts.contacts}</div></div>
      <div class="stat"><div class="label">Companies</div><div class="value">${d.counts.companies}</div></div>
      <div class="stat"><div class="label">Open Deals</div><div class="value">${d.counts.openDeals}</div>
        <div class="sub">${fmtMoney(d.totals.openPipeline)} pipeline</div></div>
      <div class="stat"><div class="label">Won Revenue</div><div class="value">${fmtMoney(d.totals.wonRevenue)}</div>
        <div class="sub">${d.counts.wonDeals} won deal(s)</div></div>
      <div class="stat"><div class="label">Activities</div><div class="value">${d.counts.activities}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel">
        <div class="panel-head"><h2>Pipeline by Stage</h2></div>
        <div style="padding:16px 18px;">
          ${d.dealsByStage.map((s) => `
            <div class="stage-bar">
              <span class="name">${STAGE_LABELS[s.stage]}</span>
              <span class="track"><span class="fill" style="width:${(s.total / maxStage) * 100}%"></span></span>
              <span class="amt">${fmtMoney(s.total)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Recent Activity</h2></div>
        <div class="activity-list">
          ${d.recentActivities.length ? d.recentActivities.map((a) => `
            <div class="activity-item">
              <span class="type">${iconFor(a.type)}</span>
              <div style="flex:1;">
                <div class="subject">${esc(a.subject)}</div>
                <div class="meta">${esc(a.contactName || '—')} · ${fmtDateTime(a.happenedAt)}</div>
              </div>
            </div>`).join('') : '<div class="empty">No activity yet.</div>'}
        </div>
      </div>
    </div>`;
}

function iconFor(type) {
  return { call: '📞', email: '✉️', meeting: '🤝', note: '📝' }[type] || '📝';
}

/* ============================ Typeahead (searchable picker) ============================ */

/**
 * Render a searchable combobox: type to filter, click (or ↑/↓ + Enter) to pick.
 * The chosen id lives in a hidden input with the given name, so FormData-based
 * form submission keeps working unchanged.
 *
 * options: [{ id, label }] — e.g. companies or contacts.
 */
function typeaheadHtml(name, options, selectedId, placeholder = 'Type to search…') {
  const selected = options.find((o) => o.id === selectedId);
  return `
    <div class="typeahead" data-name="${esc(name)}">
      <input type="text" class="ta-input" autocomplete="off" placeholder="${esc(placeholder)}"
             value="${esc(selected ? selected.label : '')}" data-selected="${esc(selected ? selected.id : '')}" />
      <input type="hidden" name="${esc(name)}" value="${esc(selected ? selected.id : '')}" />
      <button type="button" class="ta-clear" title="Clear selection" aria-label="Clear">✕</button>
      <div class="ta-menu hidden"></div>
    </div>`;
}

/** Wire up every .typeahead inside a form. optionLists: { fieldName: [{id,label}] }. */
function initTypeaheads(form, optionLists) {
  form.querySelectorAll('.typeahead').forEach((wrap) => {
    const input = wrap.querySelector('.ta-input');
    const hidden = wrap.querySelector('input[type=hidden]');
    const menu = wrap.querySelector('.ta-menu');
    const clear = wrap.querySelector('.ta-clear');
    const options = optionLists[wrap.dataset.name] || [];
    let active = -1;

    const renderMenu = (filter) => {
      const q = filter.trim().toLowerCase();
      const matches = options.filter((o) => !q || o.label.toLowerCase().includes(q)).slice(0, 30);
      if (!matches.length) { menu.classList.add('hidden'); menu.innerHTML = ''; return; }
      menu.innerHTML = matches.map((o, i) =>
        `<div class="ta-item" role="option" data-id="${esc(o.id)}" data-i="${i}">${esc(o.label)}</div>`).join('');
      menu.classList.remove('hidden');
      active = -1;
    };

    input.addEventListener('input', () => { hidden.value = ''; input.dataset.selected = ''; renderMenu(input.value); });
    input.addEventListener('focus', () => { if (!input.value) renderMenu(''); });
    input.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.ta-item')];
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); }
      else if (e.key === 'Enter' && active >= 0 && items[active]) { e.preventDefault(); items[active].click(); return; }
      else if (e.key === 'Escape') { menu.classList.add('hidden'); return; }
      items.forEach((it, i) => it.classList.toggle('active', i === active));
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.ta-item');
      if (!item) return;
      input.value = item.textContent;
      hidden.value = item.dataset.id;
      input.dataset.selected = item.dataset.id;
      menu.classList.add('hidden');
    });
    input.addEventListener('blur', () => {
      // Let a menu click land first, then close and blank un-chosen input.
      setTimeout(() => {
        menu.classList.add('hidden');
        if (!hidden.value) input.value = '';
      }, 150);
    });
    clear.addEventListener('click', () => {
      input.value = ''; hidden.value = ''; input.dataset.selected = '';
      menu.classList.add('hidden');
    });
  });
}

/* ============================ Bulk delete ============================ */

/**
 * Wire checkboxes + a selection bar for an entity view.
 * Expects [data-sel] row/card checkboxes and an optional [data-sel-all] header
 * checkbox inside the panel. Deletes via POST /api/<entity>/bulk-delete.
 */
function setupBulkDelete(panel, entity) {
  const selected = new Set();
  const head = panel.querySelector('.panel-head');
  const bar = document.createElement('div');
  bar.className = 'bulk-bar hidden';
  (head ? head.after(bar) : panel.prepend(bar));

  const updateChecks = () => panel.querySelectorAll('[data-sel]').forEach((cb) => {
    cb.checked = selected.has(cb.dataset.sel);
  });

  const renderBar = () => {
    const n = selected.size;
    bar.classList.toggle('hidden', n === 0);
    if (!n) return;
    bar.innerHTML = `<span class="bulk-count">${n} selected</span>
      <button class="btn btn-danger btn-sm" id="bulkDeleteBtn">Delete selected</button>
      <button class="btn btn-ghost btn-sm" id="bulkClearBtn">Clear</button>`;
    bar.querySelector('#bulkDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete ${n} ${entity}?`)) return;
      try {
        const data = await api('POST', `/api/${entity}/bulk-delete`, { ids: [...selected] });
        let msg = `Deleted ${data.deleted} ${entity}.`;
        if (data.skipped) msg += ` ${data.skipped} skipped (see details).`;
        toast(msg, data.skipped > 0);
        if (data.errors && data.errors.length) {
          console.log('bulk delete errors:', data.errors);
        }
        render();
      } catch (err) { toast(err.message, true); }
    });
    bar.querySelector('#bulkClearBtn').addEventListener('click', () => {
      selected.clear();
      updateChecks();
      renderBar();
    });
  };

  panel.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sel]');
    if (cb) {
      if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
      renderBar();
      return;
    }
    const all = e.target.closest('[data-sel-all]');
    if (all) {
      const boxes = [...panel.querySelectorAll('[data-sel]')];
      if (all.checked) boxes.forEach((x) => selected.add(x.dataset.sel)); else selected.clear();
      updateChecks();
      renderBar();
    }
  });
  renderBar();
}

/* ============================ Contacts ============================ */

async function renderContacts(el) {
  const [contacts, companies] = await Promise.all([
    api('GET', '/api/contacts'),
    api('GET', '/api/companies')
  ]);
  const companyNames = Object.fromEntries(companies.map((c) => [c.id, c.name]));
  const mayView = can('data.view');
  const mayCreate = can('data.create');
  const mayEdit = can('data.edit');
  const mayDelete = can('data.delete');
  const mayImport = can('import');
  const mayExport = can('export');

  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Contacts (${contacts.length})</h2>
        <div class="panel-actions">
          ${mayImport ? '<button class="btn btn-sm" data-import="contacts">⬆ Import CSV</button>' : ''}
          ${mayExport ? '<button class="btn btn-sm" data-export="contacts">⬇ Export CSV</button>' : ''}
          ${mayCreate ? '<button class="btn btn-primary btn-sm" data-new-contact>+ New Contact</button>' : ''}
        </div>
      </div>
      ${contacts.length ? `
      <table>
        <thead><tr>
          ${mayDelete ? '<th class="sel-col"><input type="checkbox" data-sel-all title="Select all" /></th>' : ''}
          <th>Name</th><th>Title</th><th>Email</th><th>Company</th><th>Status</th><th>Tags</th>${customFields.map((f) => `<th>${esc(f.label)}</th>`).join('')}${mayEdit || mayDelete ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${contacts.map((c) => `
            <tr>
              ${mayDelete ? `<td class="sel-col"><input type="checkbox" data-sel="${esc(c.id)}" /></td>` : ''}
              <td><button type="button" class="contact-name" data-edit-contact="${esc(c.id)}"><strong>${esc(c.firstName)} ${esc(c.lastName)}</strong></button>${c.address ? `<div class="meta">${esc(c.address)}</div>` : ''}</td>
              <td>${esc(c.title || '—')}</td>
              <td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td>
              <td>${esc(c.companyName || '—')}</td>
              <td><span class="badge ${esc(c.status)}">${esc(c.status)}</span></td>
              <td>${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
              ${customFields.map((f) => `<td>${esc(c.custom?.[f.id] || '—')}</td>`).join('')}
              ${mayEdit || mayDelete ? `<td class="row-actions">
                ${mayEdit ? `<button class="btn btn-sm" data-edit-contact="${esc(c.id)}">Edit</button>` : ''}
                ${mayDelete ? `<button class="btn btn-danger btn-sm" data-del-contact="${esc(c.id)}">Delete</button>` : ''}
              </td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">${mayCreate ? 'No contacts yet — add your first one.' : 'No contacts yet.'}</div>`}
    </div>`;

  el.querySelector('[data-new-contact]')?.addEventListener('click', () => contactForm(null, companies));
  el.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => importCsv(b.dataset.import)));
  el.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCsv(b.dataset.export)));
  el.querySelectorAll('[data-edit-contact]').forEach((b) => b.addEventListener('click', () => openContactForEdit(b.dataset.editContact, companies, !mayEdit)));
  el.querySelectorAll('[data-del-contact]').forEach((b) => b.addEventListener('click', () => deleteContact(b.dataset.delContact)));
  if (mayDelete) setupBulkDelete(el.querySelector('.panel'), 'contacts');
}

async function openContactForEdit(id, companies, readOnly = false) {
  const contact = await api('GET', `/api/contacts/${id}`);
  contactForm(contact, companies, { readOnly });
}

async function deleteContact(id) {
  if (!confirm('Delete this contact? Related activities will also be removed.')) return;
  try {
    await api('DELETE', `/api/contacts/${id}`);
    toast('Contact deleted');
    render();
  } catch (err) { toast(err.message, true); }
}

function contactForm(contact, companies, options = {}) {
  const readOnly = !!options.readOnly;
  const isEdit = Boolean(contact);
  const companyOptions = companies.map((c) => ({ id: c.id, label: c.name }));
  const detail = readOnly && contact && (Array.isArray(contact.deals) || Array.isArray(contact.activities))
    ? `
      <div class="full"><hr style="border:0;border-top:1px solid var(--border);margin:2px 0 10px;" />
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Deals</div>
        ${(contact.deals || []).length ? (contact.deals || []).map((d) => `<div style="font-size:13px;padding:1px 0;">💼 <strong>${esc(d.title)}</strong> · ${esc(STAGE_LABELS[d.stage] || d.stage)} · ${fmtMoney(d.amount)}</div>`).join('') : '<div class="muted" style="font-size:13px">None</div>'}
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 6px;">Activity</div>
        ${(contact.activities || []).length ? (contact.activities || []).map((a) => `<div style="font-size:13px;padding:1px 0;">${iconFor(a.type)} ${esc(a.subject)} · ${fmtDateTime(a.happenedAt)}</div>`).join('') : '<div class="muted" style="font-size:13px">None</div>'}
      </div>`
    : '';
  const title = readOnly ? esc(contact?.firstName || '') + ' ' + esc(contact?.lastName || '') : (isEdit ? 'Edit Contact' : 'New Contact');
  openModal(title, `
    <div class="form-grid">
      <div><label>First name *</label><input name="firstName" required value="${esc(contact?.firstName || '')}" /></div>
      <div><label>Last name *</label><input name="lastName" required value="${esc(contact?.lastName || '')}" /></div>
      <div class="full"><label>Email *</label><input name="email" type="email" required value="${esc(contact?.email || '')}" /></div>
      <div><label>Phone</label><input name="phone" value="${esc(contact?.phone || '')}" /></div>
      <div><label>Title</label><input name="title" value="${esc(contact?.title || '')}" /></div>
      <div class="full"><label>Address</label><input name="address" value="${esc(contact?.address || '')}" /></div>
      <div><label>Company</label>
        ${typeaheadHtml('companyId', companyOptions, contact?.companyId || null, 'Search companies…')}</div>
      <div><label>Status</label>
        <select name="status">
          ${['lead', 'prospect', 'customer', 'inactive'].map((s) => `<option ${contact?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div><label>Tags (comma separated)</label><input name="tags" value="${esc((contact?.tags || []).join(', '))}" /></div>
      <div class="full"><label>Notes</label><textarea name="notes" rows="3">${esc(contact?.notes || '')}</textarea></div>
      ${customFields.length ? `
      <div class="full"><hr style="border:0;border-top:1px solid var(--border);margin:2px 0 10px;" /><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Custom fields</div></div>
      ${customFields.map((f) => customInputHtml(f, contact?.custom?.[f.id])).join('')}` : ''}
      ${detail}
    </div>`, { readOnly });
  if (!readOnly) initTypeaheads($('#modalForm'), { companyId: companyOptions });
  if (readOnly) return; // no submit button / handler — purely a detail view
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      firstName: fd.get('firstName'), lastName: fd.get('lastName'), email: fd.get('email'),
      phone: fd.get('phone'), title: fd.get('title'), address: fd.get('address'), companyId: fd.get('companyId') || null,
      status: fd.get('status'), notes: fd.get('notes'),
      tags: String(fd.get('tags')).split(',').map((t) => t.trim()).filter(Boolean)
    };
    if (customFields.length) {
      payload.custom = Object.fromEntries(customFields.map((f) => [
        f.id,
        f.type === 'checkbox' ? (fd.get('cf_' + f.id) === 'on' ? 'true' : 'false') : String(fd.get('cf_' + f.id) || '')
      ]));
    }
    try {
      if (isEdit) await api('PUT', `/api/contacts/${contact.id}`, payload);
      else await api('POST', '/api/contacts', payload);
      toast(isEdit ? 'Contact updated' : 'Contact created');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============================ Companies ============================ */

async function renderCompanies(el) {
  const companies = await api('GET', '/api/companies');
  const mayCreate = can('data.create');
  const mayEdit = can('data.edit');
  const mayDelete = can('data.delete');
  const mayImport = can('import');
  const mayExport = can('export');

  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Companies (${companies.length})</h2>
        <div class="panel-actions">
          ${mayImport ? '<button class="btn btn-sm" data-import="companies">⬆ Import CSV</button>' : ''}
          ${mayExport ? '<button class="btn btn-sm" data-export="companies">⬇ Export CSV</button>' : ''}
          ${mayCreate ? '<button class="btn btn-primary btn-sm" data-new-company>+ New Company</button>' : ''}
        </div>
      </div>
      ${companies.length ? `
      <table>
        <thead><tr>
          ${mayDelete ? '<th class="sel-col"><input type="checkbox" data-sel-all title="Select all" /></th>' : ''}
          <th>Name</th><th>Industry</th><th>Size</th><th>Contacts</th><th>Open Pipeline</th>${mayEdit || mayDelete ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${companies.map((c) => `
            <tr>
              ${mayDelete ? `<td class="sel-col"><input type="checkbox" data-sel="${esc(c.id)}" /></td>` : ''}
              <td><strong>${esc(c.name)}</strong>${c.address ? `<div class="meta">${esc(c.address)}</div>` : ''}</td>
              <td>${esc(c.industry || '—')}</td>
              <td>${esc(c.size || '—')}</td>
              <td>${c.contactCount}</td>
              <td>${fmtMoney(c.openPipeline)}</td>
              ${mayEdit || mayDelete ? `<td class="row-actions">
                ${mayEdit ? `<button class="btn btn-sm" data-edit-company="${esc(c.id)}">Edit</button>` : ''}
                ${mayDelete ? `<button class="btn btn-danger btn-sm" data-del-company="${esc(c.id)}">Delete</button>` : ''}
              </td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">No companies yet.</div>'}
    </div>`;

  el.querySelector('[data-new-company]')?.addEventListener('click', () => companyForm(null));
  el.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => importCsv(b.dataset.import)));
  el.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCsv(b.dataset.export)));
  el.querySelectorAll('[data-edit-company]').forEach((b) => b.addEventListener('click', () => openCompanyForEdit(b.dataset.editCompany)));
  el.querySelectorAll('[data-del-company]').forEach((b) => b.addEventListener('click', () => deleteCompany(b.dataset.delCompany)));
  if (mayDelete) setupBulkDelete(el.querySelector('.panel'), 'companies');
}

async function openCompanyForEdit(id) {
  const company = await api('GET', `/api/companies/${id}`);
  companyForm(company);
}

async function deleteCompany(id) {
  if (!confirm('Delete this company? Contacts will be unlinked. Companies with deals cannot be deleted.')) return;
  try {
    await api('DELETE', `/api/companies/${id}`);
    toast('Company deleted');
    render();
  } catch (err) { toast(err.message, true); }
}

function companyForm(company) {
  const isEdit = Boolean(company);
  openModal(isEdit ? 'Edit Company' : 'New Company', `
    <div class="form-grid">
      <div class="full"><label>Name *</label><input name="name" required value="${esc(company?.name || '')}" /></div>
      <div><label>Industry</label><input name="industry" value="${esc(company?.industry || '')}" /></div>
      <div><label>Size</label>
        <select name="size">
          <option value="">—</option>
          ${['1-10', '11-50', '50-200', '200-500', '500-1000', '1000+'].map((s) => `<option ${company?.size === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div class="full"><label>Website</label><input name="website" value="${esc(company?.website || '')}" /></div>
      <div class="full"><label>Address</label><input name="address" value="${esc(company?.address || '')}" /></div>
      <div class="full"><label>Notes</label><textarea name="notes" rows="3">${esc(company?.notes || '')}</textarea></div>
    </div>`);
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { name: fd.get('name'), industry: fd.get('industry'), size: fd.get('size'), website: fd.get('website'), address: fd.get('address'), notes: fd.get('notes') };
    try {
      if (isEdit) await api('PUT', `/api/companies/${company.id}`, payload);
      else await api('POST', '/api/companies', payload);
      toast(isEdit ? 'Company updated' : 'Company created');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============================ Deals (pipeline) ============================ */

async function renderDeals(el) {
  const deals = await api('GET', '/api/deals');
  const mayCreate = can('data.create');
  const mayEdit = can('data.edit');
  const mayDelete = can('data.delete');
  const mayExport = can('export');

  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Deal Pipeline</h2>
        <div class="panel-actions">
          ${mayExport ? '<button class="btn btn-sm" data-export="deals">⬇ Export CSV</button>' : ''}
          ${mayCreate ? '<button class="btn btn-primary btn-sm" data-new-deal>+ New Deal</button>' : ''}
        </div>
      </div>
      <div class="pipeline" style="padding:14px;">
        ${STAGES.map((stage) => {
          const col = deals.filter((d) => d.stage === stage);
          const total = col.reduce((s, d) => s + Number(d.amount || 0), 0);
          return `
            <div class="column">
              <h3>${STAGE_LABELS[stage]} <span>${fmtMoney(total)}</span></h3>
              ${col.map((d) => `
                <div class="deal-card" data-edit-deal="${esc(d.id)}">
                  <div class="deal-top">
                    ${mayDelete ? `<input type="checkbox" data-sel="${esc(d.id)}" title="Select" onclick="event.stopPropagation()" />` : ''}
                    <div class="title">${esc(d.title)}</div>
                  </div>
                  <div class="amount">${fmtMoney(d.amount)}</div>
                  <div class="meta">${esc(d.companyName || 'No company')}</div>
                  <div class="meta">${esc(d.contactName || '')}</div>
                  <div class="meta">Close: ${fmtDate(d.expectedClose)}</div>
                  ${mayEdit || mayDelete ? `<div class="deal-actions">
                    ${mayEdit ? `<select class="stage-select" data-stage-for="${esc(d.id)}" style="font-size:12px;">
                      ${STAGES.map((s) => `<option value="${s}" ${s === d.stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}
                    </select>` : ''}
                    ${mayDelete ? `<button type="button" class="btn btn-danger btn-sm" data-del-deal="${esc(d.id)}">Delete</button>` : ''}
                  </div>` : ''}
                </div>`).join('') || '<div class="muted" style="text-align:center;padding:12px;">No deals</div>'}
            </div>`;
        }).join('')}
      </div>
    </div>`;

  el.querySelector('[data-new-deal]')?.addEventListener('click', () => dealForm(null));
  el.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCsv(b.dataset.export)));
  el.querySelectorAll('[data-edit-deal]').forEach((b) => b.addEventListener('click', () => openDealForEdit(b.dataset.editDeal, !mayEdit)));
  el.querySelectorAll('[data-del-deal]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); deleteDeal(b.dataset.delDeal); });
  });
  if (mayDelete) setupBulkDelete(el.querySelector('.panel'), 'deals');
  el.querySelectorAll('[data-stage-for]').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      try {
        await api('PATCH', `/api/deals/${sel.dataset.stageFor}/stage`, { stage: sel.value });
        toast(`Deal moved to ${STAGE_LABELS[sel.value]}`);
        render();
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function openDealForEdit(id, readOnly = false) {
  const deal = await api('GET', `/api/deals/${id}`);
  dealForm(deal, { readOnly });
}

async function deleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  try {
    await api('DELETE', `/api/deals/${id}`);
    toast('Deal deleted');
    render();
  } catch (err) { toast(err.message, true); }
}

async function dealForm(deal, options = {}) {
  const readOnly = !!options.readOnly;
  const [contacts, companies] = await Promise.all([api('GET', '/api/contacts'), api('GET', '/api/companies')]);
  const isEdit = Boolean(deal);
  const companyOptions = companies.map((c) => ({ id: c.id, label: c.name }));
  const contactOptions = contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}${c.email ? ` (${c.email})` : ''}` }));
  const title = readOnly ? esc(deal?.title || '') : (isEdit ? 'Edit Deal' : 'New Deal');
  openModal(title, `
    <div class="form-grid">
      <div class="full"><label>Title *</label><input name="title" required value="${esc(deal?.title || '')}" /></div>
      <div><label>Amount ($) *</label><input name="amount" type="number" min="0" required value="${deal?.amount ?? ''}" /></div>
      <div><label>Stage</label>
        <select name="stage">${STAGES.map((s) => `<option value="${s}" ${deal?.stage === s ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}</select></div>
      <div><label>Expected close</label><input name="expectedClose" type="date" value="${esc(deal?.expectedClose || '')}" /></div>
      <div><label>Company</label>
        ${typeaheadHtml('companyId', companyOptions, deal?.companyId || null, 'Search companies…')}</div>
      <div><label>Contact</label>
        ${typeaheadHtml('contactId', contactOptions, deal?.contactId || null, 'Search contacts…')}</div>
      <div class="full"><label>Notes</label><textarea name="notes" rows="3">${esc(deal?.notes || '')}</textarea></div>
    </div>`, { readOnly });
  if (!readOnly) {
    initTypeaheads($('#modalForm'), { companyId: companyOptions, contactId: contactOptions });
    $('#modalForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        title: fd.get('title'), amount: Number(fd.get('amount')), stage: fd.get('stage'),
        expectedClose: fd.get('expectedClose') || null, companyId: fd.get('companyId') || null,
        contactId: fd.get('contactId') || null, notes: fd.get('notes')
      };
      try {
        if (isEdit) await api('PUT', `/api/deals/${deal.id}`, payload);
        else await api('POST', '/api/deals', payload);
        toast(isEdit ? 'Deal updated' : 'Deal created');
        closeModal();
        render();
      } catch (err) { toast(err.message, true); }
    });
  }
}

/* ============================ Activities ============================ */

async function renderActivities(el) {
  const [activities, contacts] = await Promise.all([api('GET', '/api/activities'), api('GET', '/api/contacts')]);
  const mayCreate = can('data.create');
  const mayDelete = can('data.delete');
  const mayExport = can('export');
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Activity Log (${activities.length})</h2>
        <div class="panel-actions">
          ${mayExport ? '<button class="btn btn-sm" data-export="activities">⬇ Export CSV</button>' : ''}
          ${mayCreate ? '<button class="btn btn-primary btn-sm" data-new-activity>+ Log Activity</button>' : ''}
        </div>
      </div>
      ${activities.length ? `
      <div class="activity-list">
        ${activities.map((a) => `
          <div class="activity-item">
            ${mayDelete ? `<input type="checkbox" data-sel="${esc(a.id)}" style="margin-top:4px" />` : ''}
            <span class="type">${iconFor(a.type)}</span>
            <div style="flex:1;">
              <div class="subject">${esc(a.subject)} <span class="tag">${esc(a.type)}</span></div>
              ${a.body ? `<div class="body">${esc(a.body)}</div>` : ''}
              <div class="meta">${esc(a.contactName || '—')} · ${fmtDateTime(a.happenedAt)}</div>
            </div>
            ${mayDelete ? `<button class="btn btn-danger btn-sm" data-del-activity="${esc(a.id)}">Delete</button>` : ''}
          </div>`).join('')}
      </div>` : '<div class="empty">No activities logged yet.</div>'}
    </div>`;

  el.querySelector('[data-new-activity]')?.addEventListener('click', () => activityForm(null, contacts));
  el.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCsv(b.dataset.export)));
  el.querySelectorAll('[data-del-activity]').forEach((b) => b.addEventListener('click', () => deleteActivity(b.dataset.delActivity)));
  if (mayDelete) setupBulkDelete(el.querySelector('.panel'), 'activities');
}

async function deleteActivity(id) {
  if (!confirm('Delete this activity?')) return;
  try {
    await api('DELETE', `/api/activities/${id}`);
    toast('Activity deleted');
    render();
  } catch (err) { toast(err.message, true); }
}

function activityForm(activity, contacts) {
  const contactOptions = contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}${c.email ? ` (${c.email})` : ''}` }));
  openModal('Log Activity', `
    <div class="form-grid">
      <div><label>Type</label>
        <select name="type">${['call', 'email', 'meeting', 'note'].map((t) => `<option ${activity?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div><label>Contact <span class="opt">(optional)</span></label>
        ${typeaheadHtml('contactId', contactOptions, activity?.contactId || null, 'Search contacts…')}</div>
      <div class="full"><label>Subject *</label><input name="subject" required value="${esc(activity?.subject || '')}" /></div>
      <div class="full"><label>Notes</label><textarea name="body" rows="3">${esc(activity?.body || '')}</textarea></div>
    </div>`);
  initTypeaheads($('#modalForm'), { contactId: contactOptions });
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { type: fd.get('type'), contactId: fd.get('contactId'), subject: fd.get('subject'), body: fd.get('body') };
    try {
      await api('POST', '/api/activities', payload);
      toast('Activity logged');
      closeModal();
      render();
    } catch (err) { toast(err.message, true); }
  });
}

/* ============================ Global search ============================ */

let searchTimer;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = e.target.value.trim();
    if (!q) { render(); return; }
    try {
      const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      viewEl().innerHTML = `
        <div class="panel">
          <div class="panel-head"><h2>Search results for “${esc(q)}”</h2></div>
          <div class="activity-list">
            ${results.contacts.map((r) => `<div class="activity-item"><span class="type">👤</span><div><div class="subject">${esc(r.firstName)} ${esc(r.lastName)}</div><div class="meta">Contact · ${esc(r.email)}</div></div></div>`).join('')}
            ${results.companies.map((r) => `<div class="activity-item"><span class="type">🏢</span><div><div class="subject">${esc(r.name)}</div><div class="meta">Company · ${esc(r.industry || '')}</div></div></div>`).join('')}
            ${results.deals.map((r) => `<div class="activity-item"><span class="type">💼</span><div><div class="subject">${esc(r.title)}</div><div class="meta">Deal · ${fmtMoney(r.amount)} · ${STAGE_LABELS[r.stage]}</div></div></div>`).join('')}
            ${!results.contacts.length && !results.companies.length && !results.deals.length ? '<div class="empty">No matches found.</div>' : ''}
          </div>
        </div>`;
    } catch (err) { toast(err.message, true); }
  }, 250);
});

/* ============================ Modal ============================ */

function openModal(title, formHtml, options = {}) {
  // Replace the form element with a fresh clone so no submit listeners from a
  // previous modal survive — otherwise saving fires the request multiple times.
  const oldForm = $('#modalForm');
  if (oldForm) {
    const fresh = oldForm.cloneNode(false);
    oldForm.replaceWith(fresh);
  }
  $('#modalTitle').textContent = title;
  const footer = options.readOnly
    ? '<button type="button" class="btn btn-ghost" id="modalCancel">Close</button>'
    : '<button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button><button type="submit" class="btn btn-primary">Save</button>';
  $('#modalForm').innerHTML = `${formHtml}<div class="form-actions">${footer}</div>`;
  $('#modal').classList.remove('hidden');
  $('#modalCancel').addEventListener('click', closeModal);
  if (options.readOnly) disableModalInputs();
  $('#modalForm').querySelector('input, select, textarea')?.focus();
}

/** View-only modal: disable every field while leaving the Close button usable. */
function disableModalInputs() {
  $('#modalForm').querySelectorAll('input, select, textarea, .pw-toggle, .ta-clear, .ta-input').forEach((el) => { el.disabled = true; });
  const cancel = $('#modalCancel');
  if (cancel) cancel.disabled = false;
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal').classList.remove('expanded');
  $('#modalExpand').textContent = '⛶';
  $('#modalExpand').title = 'Expand / fullscreen';
  $('#modalForm').innerHTML = '';
}

/* ============================ Init ============================ */

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
$('#modalClose').addEventListener('click', closeModal);
$('#modalExpand').addEventListener('click', () => {
  const expanded = $('#modal').classList.toggle('expanded');
  $('#modalExpand').textContent = expanded ? '🗕' : '⛶';
  $('#modalExpand').title = expanded ? 'Restore' : 'Expand / fullscreen';
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Top "+ Add" menu — quick create for any entity.
$('#primaryAction').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#addMenu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.topbar-actions')) $('#addMenu').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#addMenu').classList.add('hidden');
});
$('#addMenu').querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
  $('#addMenu').classList.add('hidden');
  const kind = b.dataset.add;
  try {
    if (kind === 'contact') {
      const companies = await api('GET', '/api/companies');
      contactForm(null, companies);
    } else if (kind === 'company') {
      companyForm(null);
    } else if (kind === 'deal') {
      dealForm(null);
    } else if (kind === 'activity') {
      const contacts = await api('GET', '/api/contacts');
      activityForm(null, contacts);
    }
  } catch (err) {
    toast(err.message, true);
  }
}));

// Auth wiring
document.querySelectorAll('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.authTab)));
$('#authForm').addEventListener('submit', submitAuth);
$('#authForm').addEventListener('click', (e) => {
  if (e.target.id === 'forgotLink') setAuthMode('forgot');
  if (e.target.id === 'backToLogin') setAuthMode('login');
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* token may already be dead */ }
  clearSession();
  toast('Logged out');
  showAuthScreen();
});

// Plans & upgrade
$('#upgradeBtn').addEventListener('click', openUpgradeModal);

async function init() {
  if (token) {
    try {
      const { user } = await api('GET', '/api/auth/me');
      currentUser = user;
      showApp();
      return;
    } catch { /* fall through to the login screen */ }
  }
  clearSession();
  showAuthScreen();
}

init();
