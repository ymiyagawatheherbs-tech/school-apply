import { supabase } from '../lib/supabase.js';
import { handleCors } from '../lib/cors.js';
import { sendMail, getFromAddress } from '../lib/mailer.js';
import { bookingReceivedHtml, adminNotificationHtml } from '../lib/email-templates.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const LSTEP_URL = 'https://rcv.linestep.net/v3/call/2009645127';

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

    const { error: insertError } = await supabase.from('bookings').insert({
      id: bookingId, course_id: courseId,
      name, email: email.toLowerCase().trim(), phone, affiliation,
      member_type: memberType === 'member' ? 'お取引会員' : '非会員',
      price, payment_url: paymentLink.url, payment_status: '未入金',
    });
    if (insertError) throw insertError;

    const from = getFromAddress('salon');
    const courseDate = course.course_date
      ? new Date(course.course_date).toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long',
          day: 'numeric', hour: '2-digit', minute: '2-digit'
        })
      : '';

    // 受講者へメール送信
    try {
      await sendMail({
        to: email, from,
        subject: '【THE HERBS植物美容学校】ご予約受付のご確認と受講料お支払いのお願い',
        html: bookingReceivedHtml({
          name, bookingId, courseTitle: course.title,
          courseDate, place: course.place, price, paymentUrl: paymentLink.url,
        }),
      });
      console.log('受講者メール送信成功:', email);
    } catch (mailErr) {
      console.error('受講者メール送信エラー:', mailErr.message);
    }

    // 管理者通知メール
    try {
      await sendMail({
        to: process.env.ADMIN_EMAIL_SALON || 'mv@the-herbs.co.jp',
        from,
        subject: `[新規予約] ${course.title} - ${name}様`,
        html: adminNotificationHtml({
          type: '講習会予約',
          name, phone, email,
          detail: `${course.title} / ${courseDate} / ${memberType === 'member' ? 'お取引会員' : '非会員'} / 予約ID: ${bookingId}`,
        }),
      });
      console.log('管理者メール送信成功');
    } catch (mailErr) {
      console.error('管理者メール送信エラー:', mailErr.message);
    }

    // Lステップへ予約データ送信
    try {
      await fetch(LSTEP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          phone,
          course_title: course.title,
          course_date:  courseDate,
          place:        course.place,
          member_type:  memberType === 'member' ? 'お取引会員' : '非会員',
          price:        price,
          booking_id:   bookingId,
          payment_url:  paymentLink.url,
        }),
      });
      console.log('Lステップ送信成功');
    } catch (lstepErr) {
      console.error('Lステップ送信エラー:', lstepErr.message);
    }

    return res.status(200).json({ status: 'ok', bookingId, paymentUrl: paymentLink.url });

  } catch (err) {
    console.error('booking error:', err);
    return res.status(500).json({ error: err.message });
  }
}
