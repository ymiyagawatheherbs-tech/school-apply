import { supabase } from '../lib/supabase.js';
import { handleCors } from '../lib/cors.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { courseId, name, email, phone, affiliation, memberType } = req.body;
  if (!courseId || !name || !email || !phone) {
    return res.status(400).json({ error: '必須項目が不足しています' });
  }

  try {
    const { data: course, error: courseError } = await supabase
      .from('courses').select('*').eq('id', courseId).single();
    if (courseError || !course) return res.status(404).json({ error: '講座が見つかりません' });

    const { count } = await supabase
      .from('bookings').select('*', { count: 'exact', head: true })
      .eq('course_id', courseId).neq('payment_status', 'キャンセル');
    if (count >= course.capacity) return res.status(409).json({ error: '定員に達しています' });

    const price = memberType === 'member' ? course.price_member : course.price_normal;

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { count: totalCount } = await supabase
      .from('bookings').select('*', { count: 'exact', head: true });
    const bookingId = `BK${dateStr}-${String((totalCount || 0) + 1).padStart(4, '0')}`;

    // 有料講座のみStripe決済リンクを生成（0円はスキップ）
    let paymentUrl = null;
    if (price > 0) {
      const product = await stripe.products.create({
        name: course.title,
        description: `${course.course_date} | ${course.place} | 予約ID: ${bookingId}`,
      });
      const priceObj = await stripe.prices.create({
        product: product.id, unit_amount: price, currency: 'jpy',
      });
      const paymentLink = await stripe.paymentLinks.create({
        line_items: [{ price: priceObj.id, quantity: 1 }],
        after_completion: {
          type: 'redirect',
          redirect: { url: process.env.PAYMENT_SUCCESS_URL || 'https://herb-esthe.com' },
        },
      });
      paymentUrl = paymentLink.url;
    }

    const { error: insertError } = await supabase.from('bookings').insert({
      id: bookingId,
      course_id: courseId,
      name,
      email: email.toLowerCase().trim(),
      phone,
      affiliation,
      member_type: memberType === 'member' ? 'お取引会員' : '非会員',
      price,
      payment_url: paymentUrl,
      payment_status: price > 0 ? '未入金' : '無料',
    });
    if (insertError) throw insertError;

    const courseDate = course.course_date
      ? new Date(course.course_date).toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
          year: 'numeric', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '';

    try {
      const message = [
        '【新規予約】講習会申し込みがありました', '',
        `■ お名前：${name}`,
        `■ 電話：${phone}`,
        `■ メール：${email}`,
        `■ 所属：${affiliation || 'なし'}`,
        `■ 講座：${course.title}`,
        `■ 日程：${courseDate}`,
        `■ 種別：${memberType === 'member' ? 'お取引会員' : '非会員'}`,
        `■ 受講料：${price > 0 ? '¥' + price.toLocaleString() : '無料'}`,
        `■ 予約ID：${bookingId}`,
        ...(paymentUrl ? [`■ 決済リンク：${paymentUrl}`] : []),
      ].join('\n');

      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
        },
        body: JSON.stringify({
          to: process.env.LINE_ADMIN_USER_ID,
          messages: [{ type: 'text', text: message }],
        }),
      });
      console.log('LINE管理者通知送信成功');
    } catch (lineErr) {
      console.error('LINE通知エラー:', lineErr.message);
    }

    return res.status(200).json({ status: 'ok', bookingId, paymentUrl });

  } catch (err) {
    console.error('booking error:', err);
    return res.status(500).json({ error: err.message });
  }
}
