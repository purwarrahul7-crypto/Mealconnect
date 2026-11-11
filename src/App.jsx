import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import './App.css'

const STEPS = ['Placed', 'Confirmed', 'Preparing', 'Ready at gate', 'Collected']
const GATES = ['Gate No. 1', 'Gate No. 2']
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=800'
const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')
const phoneOk = (p) => /^[6-9]\d{9}$/.test(p || '')
const itemsText = (o) => (o.items || []).map((i) => `${i.name} × ${i.qty}`).join(', ')
const messageOf = (e) => e?.message || 'Something went wrong. Please try again.'

function Timeline({ status }) {
  if (status === 'Cancelled') return <p className="cancelled">This order was cancelled. Please contact the kitchen.</p>
  const i = STEPS.indexOf(status)
  return <ol className="tl">{STEPS.map((s, n) => <li key={s} className={n < i ? 'done' : n === i ? 'now' : ''}><span />{s}</li>)}</ol>
}

function OrderCard({ order }) {
  return <div className="ocard">
    <div className="ohead"><b>{order.order_number}</b><span className={'pill' + (order.order_status === 'Cancelled' ? ' bad' : '')}>{order.order_status}</span></div>
    <p className="muted">{itemsText(order)}</p>
    <p className="muted">{order.pickup_point} · {rs(order.total_amount)} · pay at pickup</p>
    <Timeline status={order.order_status} />
  </div>
}

function AuthPanel({ onClose, onAuthenticated }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const submit = async (e) => {
    e.preventDefault(); setError(''); setNotice('')
    if (mode === 'signup' && (!fullName.trim() || !phoneOk(phone))) return setError('Enter your full name and a valid 10-digit mobile number.')
    setBusy(true)
    try {
      if (mode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { data: { full_name: fullName.trim(), phone: phone.trim() } }
        })
        if (authError) throw authError
        if (data.session) {
          await ensureProfile(data.user, { full_name: fullName.trim(), phone: phone.trim() })
          onAuthenticated()
        } else {
          setNotice('Account created. Check your email to confirm it, then log in.')
          setMode('login')
        }
      } else {
        const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (authError) throw authError
        await ensureProfile(data.user)
        onAuthenticated()
      }
    } catch (err) { setError(messageOf(err)) }
    finally { setBusy(false) }
  }

  return <div className="overlay" onClick={onClose}><aside className="drawer" role="dialog" aria-modal="true" aria-label="Account" onClick={(e) => e.stopPropagation()}>
    <button className="x" onClick={onClose} aria-label="Close">×</button>
    <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
    <p className="muted">Sign in to place orders and track them across devices.</p>
    <form onSubmit={submit} className="auth-form">
      {mode === 'signup' && <><input className="field" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required /><input className="field" placeholder="10-digit mobile number" inputMode="numeric" maxLength="10" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} required /></>}
      <input className="field" type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input className="field" type="password" minLength="6" placeholder="Password (at least 6 characters)" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="ok" role="status">{notice}</p>}
      <button className="btn block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
    </form>
    <p className="muted small">{mode === 'login' ? 'New to MealConnect?' : 'Already have an account?'} <button className="text-btn" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setNotice('') }}>{mode === 'login' ? 'Create an account' : 'Log in'}</button></p>
  </aside></div>
}

async function ensureProfile(user, metadata = {}) {
  if (!user) return null
  const { data: existing, error: readError } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (readError) throw readError
  if (existing) return existing
  const { data: college, error: collegeError } = await supabase.from('colleges').select('id').eq('is_active', true).ilike('name', '%GL Bajaj%').limit(1).maybeSingle()
  if (collegeError) throw collegeError
  if (!college?.id) throw new Error('No active GL Bajaj college record found in the colleges table. Add/activate GL Bajaj in Supabase first.')
  const payload = {
    id: user.id,
    full_name: metadata.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Student',
    phone: metadata.phone || user.user_metadata?.phone || '',
    college_id: college.id
  }
  const { data, error } = await supabase.from('profiles').insert(payload).select().single()
  if (error) throw error
  return data
}

function Student({ user, profile, onAccount, onSignOut, meals, refreshMeals, orders, refreshOrders, collegeId }) {
  const [q, setQ] = useState(''), [cat, setCat] = useState('All'), [sort, setSort] = useState('')
  const [cart, setCart] = useState({}), [open, setOpen] = useState(false), [done, setDone] = useState(null)
  const [name, setName] = useState(profile?.full_name || ''), [phone, setPhone] = useState(profile?.phone || ''), [gate, setGate] = useState(GATES[1]), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const [track, setTrack] = useState('')
  const [pf, setPf] = useState({ name: '', phone: '', kitchen: '' }), [pm, setPm] = useState({ ok: false, text: '' })

  useEffect(() => { setName(profile?.full_name || ''); setPhone(profile?.phone || '') }, [profile])
  const shown = useMemo(() => {
    const t = q.toLowerCase().trim()
    const r = meals.filter((m) => (cat === 'All' || m.category === cat) && (!t || (m.name + ' ' + m.description).toLowerCase().includes(t)))
    if (sort === 'low') r.sort((a, b) => a.price - b.price)
    if (sort === 'high') r.sort((a, b) => b.price - a.price)
    return r
  }, [meals, q, cat, sort])
  const items = meals.filter((m) => cart[m.id]).map((m) => ({ ...m, n: cart[m.id] }))
  const count = items.reduce((s, i) => s + i.n, 0)
  const total = items.reduce((s, i) => s + i.n * i.price, 0)
  const add = (m) => setCart((c) => { const n = (c[m.id] || 0) + 1; return m.qty != null && n > m.qty ? c : { ...c, [m.id]: n } })
  const sub = (m) => setCart((c) => { const x = { ...c }; if ((x[m.id] || 0) <= 1) delete x[m.id]; else x[m.id]--; return x })
  const myOrders = orders.filter((o) => !track.trim() || o.order_number.toLowerCase().includes(track.trim().toLowerCase()))

  const place = async () => {
    setErr('')
    if (!user) return onAccount()
    if (!name.trim() || !phoneOk(phone)) return setErr('Enter your name and a valid 10-digit mobile number.')
    if (!items.length) return setErr('Your cart is empty.')
    const bad = items.find((i) => i.qty != null && i.n > i.qty)
    if (bad) return setErr(`Only ${bad.qty} plates of ${bad.name} left.`)
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('mealconnect_place_order', {
        p_college_id: collegeId,
        p_student_name: name.trim(),
        p_student_phone: phone,
        p_pickup_point: gate,
        p_items: items.map((i) => ({ meal_id: i.id, quantity: i.n }))
      })
      if (error) throw error
      const orderId = data?.order_id || data?.id
      await refreshMeals(); await refreshOrders()
      const placed = { order_number: data?.order_number || 'MC-' + String(orderId || '').slice(0, 8), order_status: 'Placed', total_amount: total, pickup_point: gate, items: items.map(i => ({ name: i.name, qty: i.n })) }
      setCart({}); setDone(placed); setTrack(placed.order_number); setOpen(true)
      await supabase.from('profiles').update({ full_name: name.trim(), phone }).eq('id', user.id)
    } catch (e) { setErr(messageOf(e)) }
    finally { setBusy(false) }
  }
  const partner = async (e) => {
    e.preventDefault()
    if (!pf.name.trim() || !phoneOk(pf.phone)) return setPm({ ok: false, text: 'Add your name and a valid 10-digit number.' })
    setPm({ ok: false, text: 'Partner applications are not connected yet. Please contact the MealConnect team directly.' })
  }
  const closeDrawer = () => { setOpen(false); setDone(null); setErr('') }

  return <div className="site">
    <header className="top"><div className="wrap bar"><a className="logo" href="#top">Meal<span>Connect</span></a>
      <nav><a href="#how">How it works</a><a href="#menu">Menu</a><a href="#track">Track order</a><a href="#partners">Partners</a></nav>
      <div className="row account-actions">{user ? <><span className="muted small">Hi, {profile?.full_name?.split(' ')[0] || 'Student'}</span><button className="btn ghost sm" onClick={onSignOut}>Sign out</button></> : <button className="btn ghost sm" onClick={onAccount}>Log in</button>}<button className="cartbtn" onClick={() => setOpen(true)} aria-label="Open cart">🛒 Cart{count > 0 && <b>{count}</b>}</button></div>
    </div></header>
    <section className="hero" id="top"><div className="wrap hero-grid"><div><span className="eyebrow">Made for student life</span><h1>Hot lunch at your <em>college gate</em>, every day.</h1><p className="lead">Pick meals from nearby messes and home kitchens, order by 10 am and collect at 1:00 pm. No diary entry. No overpriced stalls.</p><div className="row"><a className="btn" href="#menu">Order now</a><a className="btn ghost" href="#partners">Become a partner</a></div><ul className="chips"><li>📍 GL Bajaj gate pickup</li><li>💵 Pay at pickup</li><li>🍱 Fresh daily meals</li></ul></div><img className="himg" src="https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=1200" alt="Traditional Indian lunch thali" loading="eager" /></div></section>
    <section id="how"><div className="wrap"><h2>How MealConnect works</h2><div className="steps">{[['🍱','Explore meals','Browse daily menus from local kitchens.'],['📱','Order by 10 am','Add to cart, sign in and place your order.'],['📍','Collect at the gate','Track your order and pick it up at 1 pm.']].map(([e,t,d]) => <div className="step" key={t}><span>{e}</span><h3>{t}</h3><p>{d}</p></div>)}</div></div></section>
    <section id="menu" className="alt"><div className="wrap"><h2>Today's menu</h2><div className="campus"><span className="pill">🎓 GL Bajaj Institute of Technology</span><span className="muted">Sharda, Galgotias and KIET coming soon</span></div>
      <div className="tools"><input type="search" placeholder="Search meals" aria-label="Search meals" value={q} onChange={(e) => setQ(e.target.value)} /><div className="cats">{['All','Regular','Special'].map(c => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}</div><select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}><option value="">Sort: Default</option><option value="low">Price: Low to High</option><option value="high">Price: High to Low</option></select></div>
      <div className="grid">{shown.length === 0 && <p className="muted">No meals available yet. Ask the admin to add today's menu in Supabase.</p>}{shown.map(m => { const out = m.qty === 0, n = cart[m.id] || 0; return <article className="meal" key={m.id}><div className="thumb"><img className="meal-photo" src={m.image || FALLBACK_IMAGE} alt={m.name} loading="lazy" /><span className="tag">{m.category}</span></div><h3>{m.name}</h3><p className="muted">{m.description}</p><p className="muted small">{m.vendor}{m.qty != null && !out && m.qty <= 10 ? ` · only ${m.qty} left` : ''}</p><div className="mfoot"><b className="price">{rs(m.price)}</b>{out ? <span className="pill bad">Sold out</span> : n === 0 ? <button className="btn sm" onClick={() => add(m)}>Add</button> : <div className="step-q"><button onClick={() => sub(m)}>−</button><span>{n}</span><button onClick={() => add(m)}>+</button></div>}</div></article> })}</div>
    </div></section>
    <section id="track"><div className="wrap narrow"><h2>Track your order</h2><p className="muted">Your latest orders appear here when you are logged in. Search by order ID.</p><input className="field" placeholder="e.g. MC-12345678" value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Order ID" />{!user && <p className="muted small">Please <button className="text-btn" onClick={onAccount}>log in</button> to view your orders.</p>}{user && myOrders.length === 0 && <p className="muted">No matching orders found yet.</p>}{myOrders.map(o => <OrderCard key={o.id} order={o} />)}</div></section>
    <section id="partners" className="alt"><div className="wrap"><div className="partner"><div><h2>Run a mess or home kitchen?</h2><p>Get steady daily orders from students. Contact the MealConnect team to onboard your kitchen.</p></div><form onSubmit={partner} noValidate><input placeholder="Your name" aria-label="Your name" value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} /><input placeholder="WhatsApp number" aria-label="WhatsApp number" inputMode="numeric" maxLength="10" value={pf.phone} onChange={(e) => setPf({ ...pf, phone: e.target.value.replace(/\D/g, '') })} /><input placeholder="Kitchen name" aria-label="Kitchen name" value={pf.kitchen} onChange={(e) => setPf({ ...pf, kitchen: e.target.value })} /><button className="btn">Send interest</button>{pm.text && <p className={pm.ok ? 'ok' : 'error'} role="status">{pm.text}</p>}</form></div></div></section>
    <footer><div className="wrap"><b className="logo">Meal<span>Connect</span></b><p>Built by a GL Bajaj student, for students. Pilot launching around Greater Noida.</p><small>© 2026 MealConnect</small><p><a href="#admin" onClick={() => { window.location.hash = 'admin' }}>Admin</a></p></div></footer>
    {count > 0 && !open && <button className="cartbar" onClick={() => setOpen(true)}><span>{count} item{count > 1 ? 's' : ''}</span><b>View cart · {rs(total)}</b></button>}
    {open && <div className="overlay" onClick={closeDrawer}><aside className="drawer" role="dialog" aria-modal="true" aria-label="Cart" onClick={(e) => e.stopPropagation()}><button className="x" onClick={closeDrawer} aria-label="Close">×</button>{done ? <div><h2>🎉 Order placed</h2><p className="muted">Your order ID is <b>{done.order_number}</b>. Pay {rs(done.total_amount)} at pickup.</p><OrderCard order={done} /><a className="btn" href="#track" onClick={closeDrawer}>Track this order</a></div> : count === 0 ? <div><h2>Your cart</h2><p className="muted">Your cart is empty. Add a meal from the menu.</p></div> : <div><h2>Your cart</h2>{items.map(i => <div className="line" key={i.id}><span>{i.emoji || '🍱'} {i.name}</span><div className="step-q"><button onClick={() => sub(i)}>−</button><span>{i.n}</span><button onClick={() => add(i)}>+</button></div><b>{rs(i.n * i.price)}</b></div>)}<div className="line tot"><span>Total (pay at pickup)</span><b>{rs(total)}</b></div><input className="field" placeholder="Your full name" value={name} onChange={(e) => setName(e.target.value)} /><input className="field" placeholder="10-digit mobile number" inputMode="numeric" maxLength="10" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} /><select className="field" value={gate} onChange={(e) => setGate(e.target.value)} aria-label="Pickup gate">{GATES.map(g => <option key={g}>{g}</option>)}</select><p className="muted small">Pickup: GL Bajaj {gate}, 1:00 pm. Order before 10 am.</p>{err && <p className="error" role="alert">{err}</p>}<button className="btn block" onClick={place} disabled={busy}>{busy ? 'Placing order…' : user ? `Place order · ${rs(total)}` : 'Log in to place order'}</button></div>}</aside></div>}
  </div>
}

function Admin({ user, profile, meals, refreshMeals, orders, refreshOrders, onSignOut }) {
  const [tab, setTab] = useState('orders'), [filter, setFilter] = useState('Active'), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false)
  const blank = { name: '', vendor_id: '', price: '', description: '', category: 'Regular', qty: '', image: '' }
  const [form, setForm] = useState(blank), [editId, setEditId] = useState(null), [vendors, setVendors] = useState([])
  useEffect(() => { supabase.from('vendors').select('id,name').eq('is_active', true).then(({ data }) => setVendors(data || [])) }, [])
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const today = new Date().toDateString()
  const live = orders.filter(o => o.order_status !== 'Cancelled')
  const stats = [['New orders', orders.filter(o => o.order_status === 'Placed').length], ['Orders today', orders.filter(o => new Date(o.created_at).toDateString() === today).length], ['Revenue', rs(live.reduce((s,o) => s + Number(o.total_amount), 0))]]
  const list = orders.filter(o => filter === 'All' || (filter === 'Active' ? !['Collected','Cancelled'].includes(o.order_status) : o.order_status === filter))
  const setStatus = async (o, status) => {
    setBusy(true); setMsg('')
    const { error } = await supabase.from('orders').update({ order_status: status }).eq('id', o.id)
    if (error) setMsg(messageOf(error)); else await refreshOrders()
    setBusy(false)
  }
  const save = async () => {
    setMsg('')
    const price = Number(form.price), qty = form.qty === '' ? null : Number(form.qty)
    if (!form.name.trim() || !form.description.trim() || !(price > 0) || !form.vendor_id) return setMsg('Enter meal details, price and select a kitchen/vendor.')
    const payload = { name: form.name.trim(), description: form.description.trim(), price, category: form.category, vendor_id: form.vendor_id, image_url: form.image.trim() || null, available_quantity: qty, is_available: true }
    setBusy(true)
    const result = editId ? await supabase.from('meals').update(payload).eq('id', editId) : await supabase.from('meals').insert({ ...payload, college_id: profile.college_id })
    if (result.error) setMsg(messageOf(result.error)); else { setForm(blank); setEditId(null); setMsg(editId ? 'Meal updated.' : 'Meal added.'); await refreshMeals() }
    setBusy(false)
  }
  const remove = async (id) => { if (!window.confirm('Delete this meal?')) return; const { error } = await supabase.from('meals').delete().eq('id', id); setMsg(error ? messageOf(error) : 'Meal deleted.'); if (!error) await refreshMeals() }
  if (!profile?.is_admin) return <div className="login"><div><b className="logo">Meal<span>Connect</span> Admin</b><h2>Admin access required</h2><p className="muted">This account is not marked as an administrator in Supabase.</p><button className="btn" onClick={onSignOut}>Sign out</button></div></div>
  return <div className="admin"><div className="wrap"><div className="abar"><b className="logo">Meal<span>Connect</span> Admin</b><div className="row"><span className="muted small">{user.email}</span><a className="btn ghost sm" href="#top" onClick={() => { window.location.hash = '' }}>View site</a><button className="btn ghost sm" onClick={onSignOut}>Log out</button></div></div>
    <div className="stats">{stats.map(([k,v]) => <div className="stat" key={k}><b>{v}</b><span>{k}</span></div>)}</div><div className="cats">{['orders','menu'].map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'orders' ? 'Orders' : 'Menu'}</button>)}</div>
    {msg && <p className="error" role="status">{msg}</p>}
    {tab === 'orders' && <><div className="cats sm">{['Active','Collected','Cancelled','All'].map(c => <button key={c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>{c}</button>)}</div>{list.length === 0 && <p className="muted">No orders here yet.</p>}{list.map(o => { const nx = STEPS[STEPS.indexOf(o.order_status) + 1]; return <div className="ocard" key={o.id}><div className="ohead"><b>{o.order_number} · {new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b><span className={'pill' + (o.order_status === 'Cancelled' ? ' bad' : '')}>{o.order_status}</span></div><p>{o.student_name} · <a href={'tel:' + o.student_phone}>{o.student_phone}</a></p><p className="muted">{itemsText(o)}</p><p className="muted">{o.pickup_point} · {rs(o.total_amount)} to collect</p><div className="row">{nx && o.order_status !== 'Cancelled' && <button className="btn sm" disabled={busy} onClick={() => setStatus(o,nx)}>Mark: {nx}</button>}{!['Collected','Cancelled'].includes(o.order_status) && <button className="btn danger sm" disabled={busy} onClick={() => window.confirm('Cancel this order?') && setStatus(o,'Cancelled')}>Cancel</button>}</div></div> })}</>}
    {tab === 'menu' && <><div className="ocard form"><h3>{editId ? 'Edit meal' : 'Add a meal'}</h3><div className="two"><input className="field" placeholder="Meal name" value={form.name} onChange={set('name')} /><select className="field" value={form.vendor_id} onChange={set('vendor_id')}><option value="">Select kitchen</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div><input className="field" placeholder="Description" value={form.description} onChange={set('description')} /><input className="field" placeholder="Food photo URL (optional)" value={form.image} onChange={set('image')} /><div className="two"><input className="field" type="number" min="1" placeholder="Price (₹)" value={form.price} onChange={set('price')} /><input className="field" type="number" min="0" placeholder="Plates available (blank = unlimited)" value={form.qty} onChange={set('qty')} /></div><div className="two"><select className="field" value={form.category} onChange={set('category')}><option>Regular</option><option>Special</option></select></div><div className="row"><button className="btn" disabled={busy} onClick={save}>{editId ? 'Save changes' : 'Add meal'}</button>{editId && <button className="btn ghost" onClick={() => { setForm(blank); setEditId(null) }}>Cancel</button>}</div></div>{meals.map(m => <div className="ocard mrow" key={m.id}><div><b>{m.name}</b><p className="muted">{m.description}</p><p className="muted">{rs(m.price)} · {m.category} · {m.vendor} · {m.qty == null ? 'unlimited' : m.qty + ' plates left'}</p></div><div className="row"><button className="btn ghost sm" onClick={() => { setForm({ name:m.name, vendor_id:m.vendor_id, price:String(m.price), description:m.description, category:m.category, qty:m.qty ?? '', image:m.image || '' }); setEditId(m.id); window.scrollTo({top:0,behavior:'smooth'}) }}>Edit</button><button className="btn danger sm" onClick={() => remove(m.id)}>Delete</button></div></div>)}</>}
  </div></div>
}

export default function App() {
  const [session, setSession] = useState(null), [profile, setProfile] = useState(null), [meals, setMeals] = useState([]), [orders, setOrders] = useState([])
  const [collegeId, setCollegeId] = useState(null), [authOpen, setAuthOpen] = useState(false), [hash, setHash] = useState(window.location.hash), [loading, setLoading] = useState(true), [fatal, setFatal] = useState('')
  const user = session?.user || null
  const loadProfile = useCallback(async (u) => {
    if (!u) { setProfile(null); setCollegeId(null); return }
    const p = await ensureProfile(u)
    setProfile(p); setCollegeId(p.college_id)
  }, [])
  const refreshMeals = useCallback(async () => {
    const { data, error } = await supabase.from('meals').select('id,name,description,category,price,available_quantity,image_url,vendor_id,college_id,vendors(name)').eq('is_available', true).order('created_at', { ascending: true })
    if (error) throw error
    setMeals((data || []).map(m => ({ id:m.id, name:m.name, description:m.description || '', category:m.category || 'Regular', price:Number(m.price), qty:m.available_quantity, image:m.image_url || FALLBACK_IMAGE, vendor_id:m.vendor_id, vendor:m.vendors?.name || 'Campus kitchen', emoji:'🍱' })))
  }, [])
  const refreshOrders = useCallback(async () => {
    if (!user) { setOrders([]); return }
    let query = supabase.from('orders').select('id,order_number,student_name,student_phone,total_amount,order_status,pickup_point,created_at,user_id,order_items(meal_name,quantity,price)').order('created_at', { ascending: false }).limit(50)
    if (!profile?.is_admin) query = query.eq('user_id', user.id)
    const { data, error } = await query
    if (error) throw error
    setOrders((data || []).map(o => ({ ...o, items:(o.order_items || []).map(i => ({ name:i.meal_name, qty:i.quantity, price:Number(i.price) })) })))
  }, [user, profile?.is_admin])
  useEffect(() => {
    let alive = true
    const init = async () => {
      try {
        const { data: { session: s } } = await supabase.auth.getSession()
        if (!alive) return
        setSession(s)
        if (s?.user) await loadProfile(s.user)
        await refreshMeals()
      } catch (e) { if (alive) setFatal(messageOf(e)) }
      finally { if (alive) setLoading(false) }
    }
    init()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s?.user) { setProfile(null); setCollegeId(null); setOrders([]) }
      else setTimeout(() => loadProfile(s.user).catch(e => setFatal(messageOf(e))), 0)
    })
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => { alive = false; subscription.unsubscribe(); window.removeEventListener('hashchange', onHash) }
  }, [loadProfile, refreshMeals])
  useEffect(() => { if (user && profile) refreshOrders().catch(e => setFatal(messageOf(e))) }, [user, profile, refreshOrders])
  const signOut = async () => { await supabase.auth.signOut(); setSession(null); setProfile(null); setOrders([]); window.location.hash = '' }
  if (loading) return <div className="login"><p>Connecting to MealConnect…</p></div>
  if (fatal) return <div className="login"><div><b className="logo">Meal<span>Connect</span></b><h2>Connection issue</h2><p className="error">{fatal}</p><button className="btn" onClick={() => window.location.reload()}>Retry</button></div></div>
  return <>
    {hash === '#admin' ? (user ? <Admin user={user} profile={profile} meals={meals} refreshMeals={refreshMeals} orders={orders} refreshOrders={refreshOrders} onSignOut={signOut} /> : <div className="login"><div><b className="logo">Meal<span>Connect</span> Admin</b><h2>Admin sign in</h2><p className="muted">Log in with your administrator account to continue.</p><button className="btn" onClick={() => setAuthOpen(true)}>Log in</button><a href="#top">Back to site</a></div></div>) : <Student user={user} profile={profile} onAccount={() => setAuthOpen(true)} onSignOut={signOut} meals={meals} refreshMeals={refreshMeals} orders={orders} refreshOrders={refreshOrders} collegeId={collegeId} />}
    {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} onAuthenticated={() => setAuthOpen(false)} />}
  </>
}
