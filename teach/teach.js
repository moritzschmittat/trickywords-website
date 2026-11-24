// The teacher page: sign in by email, keep spelling lists made of dated
// sets, and hand parents the list's code. No tracking, no cookies beyond
// the sign-in itself (kept in this browser's storage).
import { createClient, qrcode } from '/teach/vendor.js';

const SUPABASE_URL = 'https://iqslfmttpqougzmvtotn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_eMk34Jl0GUfpTH88B_dPYA_5yBHK1rE';
const PAGE_URL = `${location.origin}/teach/`;
const PARENT_URL = 'https://trickywords.uk/list/?code=';
const MAX_WORDS = 40;
const MAX_WORD_LENGTH = 40;

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

// ---------- small helpers ----------

/** Builds an element. Text is always set as text, never as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => new Date(`${s}T12:00:00`);
const today = () => iso(new Date());
function addDays(isoDate, days) {
  const d = fromIso(isoDate);
  d.setDate(d.getDate() + days);
  return iso(d);
}
/** The Monday after the given day (or the coming Monday when given today). */
function nextMonday(isoDate) {
  const d = fromIso(isoDate);
  const step = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + step);
  return iso(d);
}
const niceDate = (s) => fromIso(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const showCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Words from typed or pasted text: one per line, or separated by commas. */
export function parseWords(text) {
  const seen = new Set();
  const words = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const word = raw.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').replace(/\s+/g, ' ').trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

/** A whole term: weeks are separated by an empty line. */
export function parseTerm(text) {
  return text
    .split(/\n\s*\n+/)
    .map(parseWords)
    .filter((week) => week.length > 0);
}

function wordProblem(words) {
  if (words.length === 0) return 'Add at least one word.';
  if (words.length > MAX_WORDS) return `A set can hold up to ${MAX_WORDS} words. This one has ${words.length}.`;
  const long = words.find((w) => w.length > MAX_WORD_LENGTH);
  if (long) return `"${long.slice(0, 20)}…" is too long. Is a line break missing?`;
  return null;
}

function friendly(error) {
  const message = (error && (error.message || error.error_description)) || String(error);
  if (/rate limit|too many|security purposes/i.test(message)) return 'Too many tries just now. Please wait a minute and try again.';
  if (/expired|invalid|not found/i.test(message) && /token|otp|link|code/i.test(message)) return 'That code or link is no longer valid. Ask for a new one.';
  if (/failed to fetch|network/i.test(message)) return 'No connection to the server. Check the internet connection and try again.';
  return message;
}

// ---------- the two back ends: the real server, and a pretend one for trying the page ----------

function realBackend() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  const ok = ({ data, error }) => {
    if (error) throw error;
    return data;
  };
  return {
    async email() {
      const { data } = await sb.auth.getSession();
      return data.session?.user?.email ?? null;
    },
    onChange(callback) {
      sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') callback();
      });
    },
    async sendCode(email) {
      ok(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: PAGE_URL, shouldCreateUser: true } }));
    },
    async verifyCode(email, token) {
      ok(await sb.auth.verifyOtp({ email, token, type: 'email' }));
    },
    async verifyLink(tokenHash, type) {
      ok(await sb.auth.verifyOtp({ token_hash: tokenHash, type }));
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async deleteAccount() {
      ok(await sb.rpc('delete_my_account'));
      await sb.auth.signOut({ scope: 'local' });
    },
    async schools() {
      const { data } = await sb.auth.getSession();
      const me = data.session?.user?.id;
      const rows = ok(await sb.from('schools').select('id, name, owner, created_at').order('created_at'));
      return rows.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at, mine: s.owner === me }));
    },
    async createSchool(name) {
      return ok(await sb.from('schools').insert({ name }).select('id, name').single());
    },
    async renameSchool(id, name) {
      ok(await sb.from('schools').update({ name }).eq('id', id));
    },
    async staff(schoolId) {
      const members = ok(await sb.from('school_members').select('email, added_at').eq('school_id', schoolId).order('added_at'));
      const owner = ok(await sb.rpc('school_owner_email', { p_school: schoolId }));
      return { members: members.map((m) => m.email), owner };
    },
    async invite(schoolId, email) {
      ok(await sb.from('school_members').insert({ school_id: schoolId, email }));
    },
    async removeMember(schoolId, email) {
      ok(await sb.from('school_members').delete().eq('school_id', schoolId).eq('email', email));
    },
    async handOver(schoolId, email) {
      ok(await sb.rpc('transfer_school', { p_school: schoolId, p_email: email }));
    },
    async lists(schoolId) {
      return ok(await sb.from('word_lists').select('id, name, code, created_at').eq('school_id', schoolId).order('created_at'));
    },
    async createList(schoolId, name) {
      return ok(await sb.from('word_lists').insert({ name, school_id: schoolId }).select('id, name, code, created_at').single());
    },
    async renameList(id, name) {
      ok(await sb.from('word_lists').update({ name }).eq('id', id));
    },
    async deleteList(id) {
      ok(await sb.from('word_lists').delete().eq('id', id));
    },
    async sets(listId) {
      return ok(
        await sb
          .from('word_sets')
          .select('id, list_id, title, release_date, test_date, words, created_at')
          .eq('list_id', listId)
          .order('release_date')
          .order('created_at'),
      );
    },
    async addSets(listId, sets) {
      ok(await sb.from('word_sets').insert(sets.map((s) => ({ ...s, list_id: listId }))));
    },
    async updateSet(id, patch) {
      ok(await sb.from('word_sets').update(patch).eq('id', id));
    },
    async deleteSet(id) {
      ok(await sb.from('word_sets').delete().eq('id', id));
    },
  };
}

function demoBackend() {
  let signedIn = params.get('demo') !== 'out';
  let n = 0;
  const id = () => `demo-${++n}`;
  const ME = 'teacher@example.sch.uk';
  const empty = params.get('demo') === 'new';
  const schools = empty ? [] : [{ id: id(), name: 'Oakfield Primary School', owner: ME, created_at: '2026-11-01' }];
  const staff = empty ? {} : { [schools[0].id]: [ME, 'head@example.sch.uk', 'ms.hall@example.sch.uk'] };
  const lists = empty ? [] : [{ id: id(), school_id: schools[0].id, name: 'Year 3 Oak', code: 'K7M2QD', created_at: '2026-11-01' }];
  const monday = nextMonday(addDays(today(), -14));
  const sets = [
    { id: id(), list_id: lists[0]?.id, title: 'Week 1', release_date: monday, test_date: addDays(monday, 4), words: ['because', 'friend', 'people', 'beautiful', 'Wednesday', 'answer'], created_at: '1' },
    { id: id(), list_id: lists[0]?.id, title: 'Week 2', release_date: addDays(monday, 7), test_date: addDays(monday, 11), words: ['different', 'through', 'enough', 'believe', 'island', 'necessary'], created_at: '2' },
    { id: id(), list_id: lists[0]?.id, title: 'Week 3', release_date: addDays(monday, 14), test_date: null, words: ['accident', 'address', 'calendar', 'century'], created_at: '3' },
  ];
  let changed = () => {};
  return {
    async email() {
      return signedIn ? 'teacher@example.sch.uk' : null;
    },
    onChange(callback) {
      changed = callback;
    },
    async sendCode() {},
    async verifyCode(_email, token) {
      if (token !== '123456') throw new Error('Token has expired or is invalid');
      signedIn = true;
      changed();
    },
    async verifyLink() {
      signedIn = true;
      changed();
    },
    async signOut() {
      signedIn = false;
      changed();
    },
    async deleteAccount() {
      signedIn = false;
      changed();
    },
    async schools() {
      return schools.map((s) => ({ ...s, mine: s.owner === ME }));
    },
    async createSchool(name) {
      const school = { id: id(), name, owner: ME, created_at: today() };
      schools.push(school);
      staff[school.id] = [ME];
      return school;
    },
    async renameSchool(schoolId, name) {
      schools.find((s) => s.id === schoolId).name = name;
    },
    async staff(schoolId) {
      return { members: [...(staff[schoolId] || [])], owner: schools.find((s) => s.id === schoolId).owner };
    },
    async invite(schoolId, email) {
      const clean = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('That does not look like an email address.');
      if (staff[schoolId].includes(clean)) throw new Error('duplicate key value');
      staff[schoolId].push(clean);
    },
    async removeMember(schoolId, email) {
      staff[schoolId] = staff[schoolId].filter((e) => e !== email);
    },
    async handOver(schoolId, email) {
      schools.find((s) => s.id === schoolId).owner = email;
    },
    async lists(schoolId) {
      return lists.filter((l) => l.school_id === schoolId);
    },
    async createList(schoolId, name) {
      const list = { id: id(), school_id: schoolId, name, code: 'P4T9XB', created_at: String(n) };
      lists.push(list);
      return list;
    },
    async renameList(listId, name) {
      lists.find((l) => l.id === listId).name = name;
    },
    async deleteList(listId) {
      lists.splice(lists.findIndex((l) => l.id === listId), 1);
    },
    async sets(listId) {
      return sets.filter((s) => s.list_id === listId).sort((a, b) => a.release_date.localeCompare(b.release_date) || a.created_at.localeCompare(b.created_at));
    },
    async addSets(listId, added) {
      for (const s of added) sets.push({ ...s, id: id(), list_id: listId, created_at: String(n) });
    },
    async updateSet(setId, patch) {
      Object.assign(sets.find((s) => s.id === setId), patch);
    },
    async deleteSet(setId) {
      sets.splice(sets.findIndex((s) => s.id === setId), 1);
    },
  };
}

const api = DEMO ? demoBackend() : realBackend();

// ---------- what is on the page ----------

const app = document.getElementById('app');
const state = {
  email: null,
  schools: [],
  schoolId: null,
  staff: { members: [], owner: null },
  lists: [],
  listId: null,
  sets: [],
  editing: null, // id of the set being edited
  adding: 'week', // 'week' or 'term'
  sentTo: null, // email a code was sent to
  problem: null,
  note: null,
  busy: false,
};

function show(...children) {
  app.replaceChildren(...children.flat().filter(Boolean));
}

const preview = () => h('span', { class: 'preview' }, 'Preview: parents can add a school list from app version 2.1');
const problemBox = () => (state.problem ? h('p', { class: 'problem', role: 'alert' }, state.problem) : null);
const noteBox = () => (state.note ? h('p', { class: 'done-note' }, state.note) : null);

/** Runs an action, shows what went wrong if anything, then redraws. */
async function act(job, after) {
  if (state.busy) return;
  state.busy = true;
  state.problem = null;
  state.note = null;
  try {
    await job();
    if (after) await after();
  } catch (error) {
    state.problem = friendly(error);
  }
  state.busy = false;
  render();
}

/**
 * For forms: on a problem the message appears in the form and what was typed
 * stays put. Only a success redraws the page.
 */
async function submit(problemEl, job) {
  if (state.busy) return;
  state.busy = true;
  problemEl.hidden = true;
  try {
    const refused = await job();
    if (typeof refused === 'string') throw new Error(refused);
    await refresh();
    state.problem = null;
    state.busy = false;
    render();
  } catch (error) {
    state.busy = false;
    problemEl.textContent = friendly(error);
    problemEl.hidden = false;
  }
}
const problemSlot = () => h('p', { class: 'problem', role: 'alert', hidden: !state.problem }, state.problem || '');

async function refresh() {
  state.email = await api.email();
  if (!state.email) return;
  state.sentTo = null;
  state.schools = await api.schools();
  if (!state.schools.some((s) => s.id === state.schoolId)) state.schoolId = state.schools[0]?.id ?? null;
  if (!state.schoolId) {
    state.lists = [];
    state.listId = null;
    state.sets = [];
    return;
  }
  [state.lists, state.staff] = await Promise.all([api.lists(state.schoolId), api.staff(state.schoolId)]);
  if (state.listId && !state.lists.some((l) => l.id === state.listId)) state.listId = null;
  state.sets = state.listId ? await api.sets(state.listId) : [];
}

function render() {
  const linkToken = params.get('token_hash');
  if (!state.email && linkToken && !state.usedLink) return renderConfirm(linkToken, params.get('type') || 'email');
  if (!state.email) return state.sentTo ? renderCode() : renderSignIn();
  if (!state.schoolId) return renderSetup();
  if (state.listId) return renderList(state.lists.find((l) => l.id === state.listId));
  return renderLists();
}

// ---------- signing in ----------

function renderSignIn() {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'you@yourschool.sch.uk' });
  const problem = problemSlot();
  show(
    preview(),
    h('h1', {}, 'Weekly spellings, set once'),
    h('p', { class: 'lead' }, 'Type in your class’s spelling words for the week, or for the whole term. Parents get them in the Tricky Words app on the day you choose, with no printouts to lose.'),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          const address = email.value.trim();
          submit(problem, async () => {
            await api.sendCode(address);
            state.sentTo = address;
          });
        },
      },
      h('h2', {}, 'Sign in or get started'),
      h('p', {}, 'There is no password. We email you a sign-in link and a code each time.'),
      h('label', { for: 'email' }, 'Your email address'),
      email,
      problem,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link')),
      h('p', { class: 'small muted' }, 'We use your address only to sign you in. See the ', h('a', { href: '/privacy.html' }, 'privacy policy'), '.'),
    ),
  );
}

function renderCode() {
  const code = h('input', { type: 'text', id: 'otp', class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', placeholder: '000000' });
  const problem = problemSlot();
  show(
    preview(),
    h('h1', {}, 'Check your inbox'),
    h('p', { class: 'lead' }, 'We sent an email to ', h('strong', {}, state.sentTo), '. Open the link in it, or type the code from the email here.'),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          const token = code.value.replace(/\D/g, '');
          submit(problem, () => api.verifyCode(state.sentTo, token));
        },
      },
      h('label', { for: 'otp' }, 'Code from the email'),
      code,
      problem,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Sign in')),
      h(
        'p',
        { class: 'small muted' },
        'Nothing after a couple of minutes? Check the spam folder, or ',
        h('button', { class: 'link', type: 'button', onclick: () => { state.sentTo = null; state.problem = null; render(); } }, 'try a different address'),
        '.',
      ),
    ),
  );
  code.focus();
}

/**
 * Arriving from the emailed link. School mail filters open links to scan
 * them, which would use the link up, so signing in takes one more click.
 */
function renderConfirm(tokenHash, type) {
  show(
    preview(),
    h('h1', {}, 'Almost there'),
    h(
      'div',
      { class: 'card' },
      h('p', {}, 'Tap the button to finish signing in to Tricky Words for teachers.'),
      problemBox(),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn',
            onclick: () =>
              act(async () => {
                state.usedLink = true;
                history.replaceState(null, '', PAGE_URL);
                await api.verifyLink(tokenHash, type);
              }, refresh),
          },
          'Sign in',
        ),
      ),
    ),
  );
}

// ---------- the teacher's lists ----------

function accountLine() {
  return h(
    'p',
    { class: 'small muted' },
    `Signed in as ${state.email}. `,
    h('button', { class: 'link', onclick: () => act(() => api.signOut(), refresh) }, 'Sign out'),
  );
}

/** Prints one thing: everything else on the page is hidden while printing. */
function printNode(kind, ...content) {
  for (const old of app.querySelectorAll('.print-only')) old.remove();
  app.append(h('section', { class: `print-only print-${kind}` }, content));
  window.print();
}

/** First sign-in, and not yet on any school's staff list. */
function renderSetup() {
  const name = h('input', { type: 'text', id: 'school-name', maxlength: '80', placeholder: 'For example: Oakfield Primary School', required: true });
  const problem = problemSlot();
  show(
    preview(),
    h('h1', {}, 'Set up your school'),
    accountLine(),
    h('p', { class: 'lead' }, 'One shared space for the whole school. Everyone you add sees the same lists and can change them.'),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          const value = name.value.trim();
          if (!value) return;
          submit(problem, async () => {
            const school = await api.createSchool(value);
            state.schoolId = school.id;
            state.note = 'Your school is set up. Add your first list, then add your colleagues under Staff.';
          });
        },
      },
      h('label', { for: 'school-name' }, 'School name'),
      name,
      problem,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Set up school')),
      h('p', { class: 'small muted' }, `Has a colleague already set your school up? Ask them to add ${state.email} under Staff, then sign in again. Free for your first term.`),
    ),
  );
}

function staffCard(school) {
  const email = h('input', { type: 'email', id: 'invite', placeholder: 'colleague@yourschool.sch.uk', required: true });
  const problem = problemSlot();
  const { members, owner } = state.staff;
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, `Staff (${members.length})`),
    h('p', { class: 'small muted' }, 'Everyone here signs in with their own email address, sees the same lists and can change everything.'),
    h(
      'ul',
      { class: 'staff' },
      members.map((member) =>
        h(
          'li',
          {},
          h('span', { class: 'who' }, member, member === state.email ? h('span', { class: 'tag' }, 'you') : null, member === owner ? h('span', { class: 'tag later' }, 'owner') : null),
          member === owner
            ? null
            : h(
                'span',
                { class: 'staff-actions' },
                school.mine
                  ? h('button', {
                      class: 'link',
                      onclick: () => {
                        if (window.confirm(`Make ${member} the owner of ${school.name}? They must have signed in at least once. You stay on the staff list.`)) act(() => api.handOver(school.id, member), refresh);
                      },
                    }, 'Make owner')
                  : null,
                h('button', {
                  class: 'link danger',
                  onclick: () => {
                    const self = member === state.email;
                    if (window.confirm(self ? `Leave ${school.name}? You will no longer see its lists.` : `Remove ${member}? They will no longer be able to sign in to ${school.name}.`)) act(() => api.removeMember(school.id, member), refresh);
                  },
                }, member === state.email ? 'Leave' : 'Remove'),
              ),
        ),
      ),
    ),
    h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const address = email.value.trim().toLowerCase();
          submit(problem, async () => {
            if (members.includes(address)) return 'That address is already on the list.';
            await api.invite(school.id, address);
            state.note = `${address} can now sign in at trickywords.uk/teach with that address. We do not email them, so please let them know.`;
          });
        },
      },
      h('label', { for: 'invite' }, 'Add a colleague'),
      email,
      problem,
      h('div', { class: 'row' }, h('button', { class: 'btn quiet', type: 'submit' }, 'Add to staff')),
    ),
  );
}

function renderLists() {
  const school = state.schools.find((s) => s.id === state.schoolId);
  const name = h('input', { type: 'text', id: 'list-name', maxlength: '60', placeholder: 'For example: Year 3 Oak', required: true });
  const problem = problemSlot();
  show(
    preview(),
    state.schools.length > 1
      ? h(
          'p',
          { class: 'small' },
          h(
            'select',
            { 'aria-label': 'School', onchange: (e) => act(async () => { state.schoolId = e.target.value; state.listId = null; }, refresh) },
            state.schools.map((s) => h('option', { value: s.id, selected: s.id === school.id }, s.name)),
          ),
        )
      : null,
    h('h1', {}, school.name),
    h(
      'p',
      { class: 'small muted' },
      `Signed in as ${state.email}. `,
      h('button', { class: 'link', onclick: () => act(() => api.signOut(), refresh) }, 'Sign out'),
      ' · ',
      h('button', {
        class: 'link',
        onclick: () => {
          const next = window.prompt('Name of the school', school.name);
          if (next && next.trim() && next.trim() !== school.name) act(() => api.renameSchool(school.id, next.trim().slice(0, 80)), refresh);
        },
      }, 'Rename school'),
    ),
    noteBox(),
    problemBox(),
    h('h2', {}, 'Spelling lists'),
    state.lists.length === 0
      ? h('p', { class: 'muted' }, 'Start with one list per class. Parents subscribe to a list with its code.')
      : h(
          'ul',
          { class: 'lists' },
          state.lists.map((list) =>
            h(
              'li',
              {},
              h(
                'button',
                { class: 'list-link', onclick: () => act(async () => { state.listId = list.id; state.editing = null; }, refresh) },
                h('span', {}, h('strong', {}, list.name)),
                h('span', { class: 'code' }, showCode(list.code)),
              ),
            ),
          ),
        ),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          const value = name.value.trim();
          if (!value) return;
          submit(problem, async () => {
            const list = await api.createList(school.id, value);
            state.listId = list.id;
          });
        },
      },
      h('h2', {}, 'New list'),
      h('label', { for: 'list-name' }, 'Name ', h('span', { class: 'hint' }, 'Parents see this. Please do not use a child’s name.')),
      name,
      problem,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Create list')),
    ),
    staffCard(school),
    h(
      'p',
      { class: 'small muted' },
      'Finished with Tricky Words? ',
      h(
        'button',
        {
          class: 'link danger',
          onclick: () => {
            const alone = state.staff.members.length <= 1;
            const warning = school.mine && alone
              ? `Delete your account and ${school.name} with all its lists? Parents will stop receiving new words. This cannot be undone.`
              : 'Delete your account? The school and its lists stay for your colleagues.';
            if (window.confirm(warning)) {
              act(async () => {
                await api.deleteAccount();
                state.note = null;
              }, refresh);
            }
          },
        },
        'Delete my account',
      ),
    ),
  );
}

function qrFor(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const box = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code for parents' });
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // made by the library from our own link
  return box;
}

function renderList(list) {
  const todayIso = today();
  const sent = state.sets.filter((s) => s.release_date <= todayIso);
  const waiting = state.sets.filter((s) => s.release_date > todayIso);
  const lastDate = state.sets.length ? state.sets[state.sets.length - 1].release_date : todayIso;
  const suggested = nextMonday(lastDate < todayIso ? addDays(todayIso, -1) : lastDate);
  const link = PARENT_URL + list.code;

  show(
    h('p', { class: 'crumb' }, h('button', { class: 'link', onclick: () => act(async () => { state.listId = null; }, refresh) }, `← ${state.schools.find((sc) => sc.id === state.schoolId)?.name ?? 'All lists'}`)),
    h('span', { class: 'preview' }, 'Preview: please wait before handing the code out. Parents need app version 2.1.'),
    h('h1', {}, list.name),
    noteBox(),
    problemBox(),
    h(
      'div',
      { class: 'card handout' },
      h(
        'div',
        {},
        h('h2', {}, 'Code for parents'),
        h('p', { class: 'bigcode' }, showCode(list.code)),
        h('p', { class: 'small muted' }, 'Hand this out once. Parents type it into the Tricky Words app, or scan the QR code, and get every set on its date.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn quiet', onclick: () => printNode('note', parentNote(list)) }, 'Print a note for parents'),
          h('button', {
            class: 'link',
            onclick: () => {
              const next = window.prompt('Name of this list', list.name);
              if (next && next.trim() && next.trim() !== list.name) act(() => api.renameList(list.id, next.trim().slice(0, 60)), refresh);
            },
          }, 'Rename'),
          h('button', {
            class: 'link danger',
            onclick: () => {
              if (window.confirm(`Delete "${list.name}" and all its words? Parents will stop receiving new words. This cannot be undone.`)) {
                act(async () => {
                  await api.deleteList(list.id);
                  state.listId = null;
                }, refresh);
              }
            },
          }, 'Delete list'),
        ),
      ),
      qrFor(link),
    ),

    addForm(list, suggested),

    h('h2', {}, waiting.length ? `Scheduled (${waiting.length})` : 'Scheduled'),
    waiting.length ? h('ul', { class: 'sets' }, waiting.map((s) => setCard(s, false))) : h('p', { class: 'muted' }, 'Nothing waiting to go out.'),
    h('h2', {}, sent.length ? `With parents (${sent.length})` : 'With parents'),
    sent.length ? h('ul', { class: 'sets' }, [...sent].reverse().map((s) => setCard(s, true))) : h('p', { class: 'muted' }, 'Nothing has gone out yet.'),
  );
}

/** The note that goes home once: the code, the QR code and three steps. */
function parentNote(list) {
  return [
    h('h1', {}, `${list.name}: spellings on your phone`),
    h('p', {}, 'Each week’s spelling words arrive in the Tricky Words app automatically.'),
    qrFor(PARENT_URL + list.code),
    h('p', { class: 'bigcode' }, showCode(list.code)),
    h(
      'ol',
      {},
      h('li', {}, 'Install Tricky Words from the App Store.'),
      h('li', {}, 'Scan the QR code with your phone’s camera, or open Words in the app, choose “Add a school list” and type the code.'),
      h('li', {}, 'Practise a few minutes a day. New words appear on the day they are set.'),
    ),
    h('p', {}, 'trickywords.uk'),
  ];
}

const setCaption = (set) => [set.title, set.test_date ? `Test ${niceDate(set.test_date)}` : null].filter(Boolean).join(' · ');

/** One week's words as a practice sheet: the word, then room to write it three times. */
function weekSheet(list, set) {
  return [
    h('h1', {}, list.name),
    h('p', { class: 'sheet-sub' }, setCaption(set) || 'Spelling words'),
    h(
      'table',
      { class: 'sheet' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Look'), h('th', {}, 'Cover and write'), h('th', {}, 'Check and write'), h('th', {}, 'Once more'))),
      h('tbody', {}, set.words.map((w) => h('tr', {}, h('td', { class: 'w' }, w), h('td', {}), h('td', {}), h('td', {})))),
    ),
    h('p', { class: 'sheet-foot' }, 'Practise on your phone too: trickywords.uk'),
  ];
}

/** The same words repeated as small slips, to cut out and stick in writing books. */
function weekSlips(list, set) {
  const perPage = set.words.length > 12 ? 4 : 8;
  return h(
    'div',
    { class: `slips slips-${perPage}` },
    Array.from({ length: perPage }, () =>
      h('div', { class: 'slip' }, h('strong', {}, list.name), h('span', { class: 'slip-sub' }, setCaption(set) || 'Spelling words'), h('ul', {}, set.words.map((w) => h('li', {}, w)))),
    ),
  );
}

const currentList = () => state.lists.find((l) => l.id === state.listId);

function setCard(set, isSent) {
  if (state.editing === set.id) return h('li', { class: 'set' }, editForm(set));
  return h(
    'li',
    { class: isSent ? 'set' : 'set waiting' },
    h(
      'div',
      { class: 'set-head' },
      h('strong', {}, set.title || 'Words'),
      h('span', { class: isSent ? 'tag' : 'tag later' }, isSent ? `Went out ${niceDate(set.release_date)}` : `Goes out ${niceDate(set.release_date)}`),
      set.test_date ? h('span', { class: 'small muted' }, `Test ${niceDate(set.test_date)}`) : null,
      h('span', { class: 'small muted' }, `${set.words.length} ${set.words.length === 1 ? 'word' : 'words'}`),
    ),
    h('div', { class: 'words' }, set.words.map((w) => h('span', {}, w))),
    h(
      'div',
      { class: 'set-actions' },
      h('button', { class: 'link', onclick: () => { state.editing = set.id; state.problem = null; render(); } }, 'Edit'),
      h('button', { class: 'link', onclick: () => printNode('sheet', weekSheet(currentList(), set)) }, 'Print sheet'),
      h('button', { class: 'link', onclick: () => printNode('slips', weekSlips(currentList(), set)) }, 'Print slips for books'),
      h('button', {
        class: 'link danger',
        onclick: () => {
          const warning = isSent ? 'Parents who already have these words keep them. ' : '';
          if (window.confirm(`Delete "${set.title || 'this set'}"? ${warning}This cannot be undone.`)) act(() => api.deleteSet(set.id), refresh);
        },
      }, 'Delete'),
    ),
  );
}

function editForm(set) {
  const title = h('input', { type: 'text', maxlength: '60', value: set.title });
  const release = h('input', { type: 'date', value: set.release_date, required: true });
  const test = h('input', { type: 'date', value: set.test_date || '' });
  const words = h('textarea', {});
  words.value = set.words.join('\n');
  const problem = problemSlot();
  return h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const list = parseWords(words.value);
        submit(problem, async () => {
          const refused = wordProblem(list) || (release.value ? null : 'Choose the day the words go out.');
          if (refused) return refused;
          await api.updateSet(set.id, { title: title.value.trim(), release_date: release.value, test_date: test.value || null, words: list });
          state.editing = null;
        });
      },
    },
    h('label', {}, 'Title', title),
    h('div', { class: 'two' }, h('label', {}, 'Goes out on', release), h('label', {}, 'Spelling test ', h('span', { class: 'hint' }, '(optional)'), test)),
    h('label', {}, 'Words ', h('span', { class: 'hint' }, 'one per line'), words),
    problem,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', type: 'submit' }, 'Save'),
      h('button', { class: 'btn quiet', type: 'button', onclick: () => { state.editing = null; state.problem = null; render(); } }, 'Cancel'),
    ),
  );
}

/** Add one week, or paste a whole term with an empty line between weeks. */
function addForm(list, suggested) {
  const term = state.adding === 'term';
  const nextNumber = state.sets.length + 1;
  const title = h('input', { type: 'text', maxlength: '60', value: `Week ${nextNumber}` });
  const release = h('input', { type: 'date', value: suggested, required: true });
  const test = h('input', { type: 'date' });
  const testGap = h(
    'select',
    {},
    h('option', { value: '' }, 'No test date'),
    h('option', { value: '4' }, '4 days after the words go out (Monday to Friday)'),
    h('option', { value: '7' }, 'A week after the words go out'),
  );
  const words = h('textarea', {
    placeholder: term ? 'because\nfriend\npeople\n\ndifferent\nthrough\nenough\n\n(an empty line starts the next week)' : 'because\nfriend\npeople',
  });
  const plan = h('div', { class: 'plan muted' });
  const problem = problemSlot();

  const planned = () => {
    if (!term) return [{ title: title.value.trim(), release_date: release.value, test_date: test.value || null, words: parseWords(words.value) }];
    return parseTerm(words.value).map((week, i) => {
      const date = addDays(release.value || suggested, 7 * i);
      return { title: `Week ${nextNumber + i}`, release_date: date, test_date: testGap.value ? addDays(date, Number(testGap.value)) : null, words: week };
    });
  };
  const showPlan = () => {
    if (!term) return;
    const weeks = planned();
    plan.replaceChildren(
      weeks.length === 0
        ? 'Paste the words, with an empty line between weeks.'
        : h(
            'ul',
            {},
            weeks.map((w) => h('li', {}, `${w.title}: ${w.words.length} ${w.words.length === 1 ? 'word' : 'words'}, goes out ${niceDate(w.release_date)}`)),
          ),
    );
  };
  if (term) {
    words.addEventListener('input', showPlan);
    release.addEventListener('change', showPlan);
    showPlan();
  }

  return h(
    'form',
    {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        const sets = planned();
        submit(problem, async () => {
          let refused = !release.value ? 'Choose the day the words go out.' : sets.length === 0 ? 'Add at least one word.' : null;
          for (const s of sets) refused = refused || wordProblem(s.words);
          if (refused) return refused;
          await api.addSets(list.id, sets);
          state.note = sets.length === 1 ? `Saved. ${sets[0].release_date <= today() ? 'Parents get these words the next time they open the app.' : `These words go out on ${niceDate(sets[0].release_date)}.`}` : `Saved ${sets.length} weeks. Each one goes out on its date.`;
        });
      },
    },
    h('h2', {}, 'Add words'),
    h(
      'div',
      { class: 'tabs', role: 'tablist' },
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(!term), onclick: () => { state.adding = 'week'; state.problem = null; render(); } }, 'One week'),
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(term), onclick: () => { state.adding = 'term'; state.problem = null; render(); } }, 'A whole term'),
    ),
    term
      ? [
          h('p', { class: 'small muted' }, 'Paste every week’s words, with an empty line between weeks. They go out one week apart, and you can move any date afterwards (for half term, say).'),
          h('div', { class: 'two' }, h('label', {}, 'First week goes out on', release), h('label', {}, 'Spelling tests', testGap)),
        ]
      : [
          h('label', {}, 'Title', title),
          h('div', { class: 'two' }, h('label', {}, 'Goes out on', release), h('label', {}, 'Spelling test ', h('span', { class: 'hint' }, '(optional)'), test)),
        ],
    h('label', {}, 'Words ', h('span', { class: 'hint' }, 'one per line, or separated by commas'), words),
    term ? plan : null,
    problem,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, term ? 'Save the term' : 'Save')),
  );
}

// ---------- start ----------

if (app) {
  // A link that failed on the server's side comes back with the reason in the address.
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('error_description')) state.problem = friendly({ message: hash.get('error_description').replace(/\+/g, ' ') });

  // The sign-in library also reports "signed in" when the tab regains focus:
  // only redraw when the person really changed, so typing is never wiped.
  api.onChange(async () => {
    if (state.busy) return;
    const email = await api.email();
    if (email === state.email) return;
    refresh().then(render, render);
  });
  refresh()
    .catch((error) => {
      state.problem = friendly(error);
    })
    .then(render);
}
