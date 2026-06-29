export default {
  async fetch(request, env, ctx) {
    const { BOT_TOKEN, BOT_USERNAME, OWNER_ID, DB } = env;
    const NEW_LINK_TEXT = "✨ ساخت لینک ناشناس جدید";

    async function telegramAPI(method, payload) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        return await res.json();
      } catch (error) {
        return null;
      }
    }

    async function isUserSubscribed(userId) {
      const { results } = await DB.prepare("SELECT chat_id FROM channels").all();
      if (!results || results.length === 0) return { ok: true, channels: [] };

      let notJoined = [];
      const botId = BOT_TOKEN.split(':')[0];

      for (const row of results) {
        const channel = row.chat_id;

        const botCheck = await telegramAPI("getChatMember", { chat_id: channel, user_id: botId });
        if (!botCheck?.ok || botCheck.result?.status !== "administrator") {
          await DB.prepare("DELETE FROM channels WHERE chat_id = ?").bind(channel).run();
          await telegramAPI("sendMessage", {
            chat_id: OWNER_ID,
            text: `⚠️ سیستم هوشمند:\nربات از کانال ${channel} اخراج شده یا دسترسی ادمین آن لغو شده است. این کانال به صورت خودکار از سیستم قفل اجباری حذف گردید.`
          });
          continue;
        }

        const res = await telegramAPI("getChatMember", { chat_id: channel, user_id: userId });
        if (!res?.ok || !["member", "administrator", "creator"].includes(res.result?.status)) {
          notJoined.push(channel);
        }
      }
      return { ok: notJoined.length === 0, channels: notJoined };
    }

    function generateRandomKey(length = 8) {
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    const encodeId = (id) => Number(id).toString(16).split("").reverse().join("");
    const decodeId = (hx) => parseInt(hx.split("").reverse().join(""), 16).toString();

    async function handleUpdate(update) {
      const message = update.message;
      const callbackQuery = update.callback_query;
      const user = message?.from || callbackQuery?.from;
      if (!user) return new Response("No user");

      const userId = user.id.toString();
      const text = message?.text || "";

      if (userId === OWNER_ID) {
        let userRecord = await DB.prepare("SELECT admin_state FROM users WHERE telegram_id = ?").bind(userId).first();
        const adminState = userRecord?.admin_state || '';

        if (text === "/admin") {
          await DB.prepare("UPDATE users SET admin_state = '' WHERE telegram_id = ?").bind(userId).run();
          await telegramAPI("sendMessage", {
            chat_id: userId,
            text: "⚙️ **پنل مدیریت پیشرفته ربات**\n\nجهت مدیریت سیستم قفل کانال‌ها از گزینه‌های زیر استفاده کنید:",
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ افزودن کانال جدید", callback_data: "admin_add_ch" }],
                [{ text: "📋 مدیریت کانال‌ها", callback_data: "admin_list_ch" }]
              ]
            }
          });
          return new Response("Admin");
        }

        if (adminState === "waiting_add_channel" && !callbackQuery) {
          if (text.startsWith("@") || text.startsWith("-100")) {
            await DB.prepare("UPDATE users SET admin_state = '' WHERE telegram_id = ?").bind(userId).run();
            await telegramAPI("sendMessage", {
              chat_id: userId,
              text: `⏳ در حال پیکربندی کانال ${text}...\n\nلطفاً هم‌اکنون ربات را در این کانال ادمین کنید. پس از اطمینان از ادمین بودن ربات، روی دکمه زیر کلیک کنید تا اعتبارسنجی انجام شود:`,
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ ادمینت کردم (بررسی کن)", callback_data: `verify_admin_${text}` }]
                ]
              }
            });
          } else {
            await telegramAPI("sendMessage", { chat_id: userId, text: "⚠️ فرمت شناسه نامعتبر است. باید با @ یا -100 آغاز شود." });
          }
          return new Response("Add Ch");
        }
      }

      if (callbackQuery) {
        const cbId = callbackQuery.id;
        const data = callbackQuery.data;

        if (data.startsWith("admin_") || data.startsWith("verify_admin_") || data === "noop") {
          if (userId !== OWNER_ID) return new Response("Unauth");

          if (data === "admin_add_ch") {
            await DB.prepare("UPDATE users SET admin_state = 'waiting_add_channel' WHERE telegram_id = ?").bind(userId).run();
            await telegramAPI("sendMessage", { chat_id: userId, text: "لطفاً شناسه کانال مورد نظر را ارسال کنید (مثال: @ChannelID یا شناسه عددی):" });
          }
          else if (data === "admin_list_ch") {
            const { results } = await DB.prepare("SELECT chat_id FROM channels").all();
            if (!results || results.length === 0) {
              await telegramAPI("sendMessage", { chat_id: userId, text: "هیچ کانالی در سیستم ثبت نشده است." });
            } else {
              const keyboard = results.map(r => [
                { text: r.chat_id, callback_data: "noop" },
                { text: "❌ حذف کانال", callback_data: `admin_delch_${r.chat_id}` }
              ]);
              await telegramAPI("sendMessage", {
                chat_id: userId,
                text: "📋 لیست کانال‌های فعال در سیستم قفل اجباری:",
                reply_markup: { inline_keyboard: keyboard }
              });
            }
          }
          else if (data.startsWith("admin_delch_")) {
            const channel = data.replace("admin_delch_", "");
            await DB.prepare("DELETE FROM channels WHERE chat_id = ?").bind(channel).run();
            await telegramAPI("answerCallbackQuery", { callback_query_id: cbId, text: `کانال ${channel} با موفقیت از سیستم حذف شد.`, show_alert: true });
            await telegramAPI("deleteMessage", { chat_id: userId, message_id: callbackQuery.message.message_id });
          }
          else if (data.startsWith("verify_admin_")) {
            const channel = data.replace("verify_admin_", "");
            const botId = BOT_TOKEN.split(":")[0];
            const check = await telegramAPI("getChatMember", { chat_id: channel, user_id: botId });

            if (check?.ok && check.result?.status === "administrator") {
              await DB.prepare("INSERT OR IGNORE INTO channels (chat_id) VALUES (?)").bind(channel).run();
              await telegramAPI("editMessageText", {
                chat_id: userId,
                message_id: callbackQuery.message.message_id,
                text: `✅ تایید شد! ربات در کانال ${channel} ادمین است. کانال با موفقیت به قفل اجباری متصل گردید.`
              });
            } else {
              await telegramAPI("answerCallbackQuery", {
                callback_query_id: cbId,
                text: "❌ اعتبارسنجی ناموفق! ربات هنوز در کانال ادمین نشده یا شناسه نامعتبر است.",
                show_alert: true
              });
            }
          }
          await telegramAPI("answerCallbackQuery", { callback_query_id: cbId });
          return new Response("Admin CB");
        }

        if (data.startsWith("seen_")) {
          const [, senderId, msgId] = data.split("_");
          await telegramAPI("sendMessage", {
            chat_id: senderId,
            text: "✔️ پیام شما توسط گیرنده خوانده شد.",
            reply_to_message_id: parseInt(msgId)
          });

          let userRecord = await DB.prepare("SELECT blocked FROM users WHERE telegram_id = ?").bind(userId).first();
          let blockedList = userRecord?.blocked ? userRecord.blocked.split(",") : [];
          let isBlocked = blockedList.includes(senderId);

          await telegramAPI("editMessageReplyMarkup", {
            chat_id: userId,
            message_id: callbackQuery.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "✏️ پاسخ به این", callback_data: `rep_${senderId}_${msgId}` }],
                [{ text: isBlocked ? "✅ رفع بلاک" : "⛔ بلاک", callback_data: `${isBlocked ? 'unblock' : 'block'}_${senderId}_${msgId}` }]
              ]
            }
          });
          await telegramAPI("answerCallbackQuery", { callback_query_id: cbId, text: "وضعیت بازدید به فرستنده اعلام شد." });
          return new Response("Seen");
        }

        if (data.startsWith("block_") || data.startsWith("unblock_")) {
          const [action, targetId, msgId] = data.split("_");
          let userRecord = await DB.prepare("SELECT blocked FROM users WHERE telegram_id = ?").bind(userId).first();
          let blockedList = userRecord?.blocked ? userRecord.blocked.split(",") : [];
          const hasSeenButton = callbackQuery.message.reply_markup.inline_keyboard.some(row => row.some(btn => btn.callback_data.startsWith("seen_")));

          let newKeyboard = [];
          if (action === "block") {
            if (!blockedList.includes(targetId)) blockedList.push(targetId);
            await DB.prepare("UPDATE users SET blocked = ? WHERE telegram_id = ?").bind(blockedList.join(","), userId).run();
            newKeyboard = [
              [{ text: "✏️ پاسخ به این", callback_data: `rep_${targetId}_${msgId}` }],
              [{ text: "✅ رفع بلاک", callback_data: `unblock_${targetId}_${msgId}` }]
            ];
            if (hasSeenButton) newKeyboard.push([{ text: "👁️ اعلام مشاهده کردم", callback_data: `seen_${targetId}_${msgId}` }]);
            await telegramAPI("answerCallbackQuery", { callback_query_id: cbId, text: "کاربر بلاک شد.", show_alert: true });
          } else {
            blockedList = blockedList.filter(id => id !== targetId);
            await DB.prepare("UPDATE users SET blocked = ? WHERE telegram_id = ?").bind(blockedList.join(","), userId).run();
            newKeyboard = [
              [{ text: "✏️ پاسخ به این", callback_data: `rep_${targetId}_${msgId}` }],
              [{ text: "⛔ بلاک", callback_data: `block_${targetId}_${msgId}` }]
            ];
            if (hasSeenButton) newKeyboard.push([{ text: "👁️ اعلام مشاهده کردم", callback_data: `seen_${targetId}_${msgId}` }]);
            await telegramAPI("answerCallbackQuery", { callback_query_id: cbId, text: "کاربر از بلاک خارج شد.", show_alert: true });
          }

          await telegramAPI("editMessageReplyMarkup", {
            chat_id: userId,
            message_id: callbackQuery.message.message_id,
            reply_markup: { inline_keyboard: newKeyboard }
          });
          return new Response("Block");
        }

        if (data.startsWith("rep_")) {
          const [, senderId, msgId] = data.split("_");
          await DB.prepare("UPDATE users SET reply_to_user = ?, reply_to_msg_id = ?, target_user = '' WHERE telegram_id = ?")
            .bind(senderId, msgId, userId).run();
          await telegramAPI("answerCallbackQuery", { callback_query_id: cbId });
          await telegramAPI("sendMessage", {
            chat_id: userId,
            text: "✍️ متن پاسخ خود را ارسال کنید تا مستقیماً به پیام کاربر ریپلای شود:",
            reply_markup: { remove_keyboard: true }
          });
          return new Response("Rep");
        }
      }

      if (userId !== OWNER_ID) {
        const joinCheck = await isUserSubscribed(userId);
        if (!joinCheck.ok) {
          const buttons = joinCheck.channels.map(ch => [{ text: `عضویت در کانال ${ch}`, url: `https://t.me/${ch.replace("@", "")}` }]);
          buttons.push([{ text: "✅ تایید عضویت", url: `https://t.me/${BOT_USERNAME}?start=check` }]);
          await telegramAPI("sendMessage", {
            chat_id: userId,
            text: "🔐 برای استفاده از تمامی امکانات ربات، لطفا ابتدا در کانال‌های زیر عضو شوید، سپس روی دکمه تایید عضویت کلیک کنید:",
            reply_markup: { inline_keyboard: buttons }
          });
          return new Response("Sub");
        }
      }

      let me = await DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(userId).first();
      const currentName = user.first_name || "کاربر ناشناس";
      const currentUsername = user.username || "";

      if (!me) {
        const randomKey = generateRandomKey();
        await DB.prepare("INSERT INTO users (telegram_id, rkey, username, name) VALUES (?, ?, ?, ?)")
          .bind(userId, randomKey, currentUsername, currentName).run();
        me = { telegram_id: userId, rkey: randomKey, target_user: '', reply_to_user: '', reply_to_msg_id: '' };
      } else {
        await DB.prepare("UPDATE users SET username = ?, name = ? WHERE telegram_id = ?").bind(currentUsername, currentName, userId).run();
      }

      if (text === NEW_LINK_TEXT || text === "/link") {
        const anonymousLink = `https://t.me/${BOT_USERNAME}?start=${me.rkey}_${encodeId(userId)}`;
        await telegramAPI("sendMessage", {
          chat_id: userId,
          text: `🔗 **لینک ناشناس اختصاصی شما:**\n\n\`${anonymousLink}\`\n\nاین لینک را در بیو یا استوری خود قرار دهید تا پیام‌های ناشناس دریافت کنید.`,
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [[{ text: NEW_LINK_TEXT }]],
            resize_keyboard: true
          }
        });
        return new Response("Link");
      }

      if (text.startsWith("/start")) {
        const match = text.match(/\/start (\w+)_(\w+)/);
        if (match) {
          const [, rkey, hx] = match;
          const targetId = decodeId(hx);
          if (targetId === userId) {
            await telegramAPI("sendMessage", { chat_id: userId, text: "شما نمی‌توانید به خودتان پیام ناشناس ارسال کنید." });
            return new Response("Self");
          }

          const targetUser = await DB.prepare("SELECT rkey, name FROM users WHERE telegram_id = ?").bind(targetId).first();
          if (targetUser && targetUser.rkey === rkey) {
            await DB.prepare("UPDATE users SET target_user = ?, reply_to_user = '', reply_to_msg_id = '' WHERE telegram_id = ?").bind(targetId, userId).run();
            await telegramAPI("sendMessage", {
              chat_id: userId,
              text: `✨ شما در حال ارسال پیام ناشناس به **${targetUser.name}** هستید.\n\nمتن، تصویر، ویدیو یا صدای خود را ارسال کنید:`,
              parse_mode: "Markdown",
              reply_markup: { remove_keyboard: true }
            });
            return new Response("Ready");
          }
        }

        await telegramAPI("sendMessage", {
          chat_id: userId,
          text: "سلام! به ربات پیام ناشناس پیشرفته خوش آمدید.\nبرای دریافت لینک اختصاصی خود روی دکمه زیر کلیک کنید:",
          reply_markup: {
            keyboard: [[{ text: NEW_LINK_TEXT }]],
            resize_keyboard: true
          }
        });
        return new Response("Start");
      }

      if (me.target_user || me.reply_to_user) {
        const receiverId = me.reply_to_user ? me.reply_to_user : me.target_user;
        const targetRecord = await DB.prepare("SELECT blocked FROM users WHERE telegram_id = ?").bind(receiverId).first();
        let receiverBlockedList = targetRecord?.blocked ? targetRecord.blocked.split(",") : [];

        if (receiverBlockedList.includes(userId)) {
          await telegramAPI("sendMessage", { chat_id: userId, text: "⚠️ شما توسط این کاربر مسدود شده‌اید و امکان ارسال پیام ندارید." });
          await DB.prepare("UPDATE users SET target_user = '', reply_to_user = '', reply_to_msg_id = '' WHERE telegram_id = ?").bind(userId).run();
          return new Response("Blocked");
        }

        const typeStr = me.reply_to_msg_id ? "یک پاسخ جدید دریافت کردید" : "یک پیام جدید دریافت کردید";
        const inlineKeyboard = [
          [{ text: "✏️ پاسخ به این", callback_data: `rep_${userId}_${message.message_id}` }],
          [{ text: "⛔ بلاک", callback_data: `block_${userId}_${message.message_id}` }],
          [{ text: "👁️ اعلام مشاهده کردم", callback_data: `seen_${userId}_${message.message_id}` }]
        ];

        let copyRes;
        if (message.text) {
          let payload = {
            chat_id: receiverId,
            text: `✉️ **${typeStr}:**\n\n${message.text}`,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: inlineKeyboard }
          };
          if (me.reply_to_msg_id) payload.reply_to_message_id = parseInt(me.reply_to_msg_id);
          copyRes = await telegramAPI("sendMessage", payload);
        } else {
          let formattedCaption = `✉️ **${typeStr}**` + (message.caption ? `:\n\n${message.caption}` : '');
          let payload = {
            chat_id: receiverId,
            from_chat_id: userId,
            message_id: message.message_id,
            caption: formattedCaption,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: inlineKeyboard }
          };
          if (me.reply_to_msg_id) payload.reply_to_message_id = parseInt(me.reply_to_msg_id);
          copyRes = await telegramAPI("copyMessage", payload);
        }

        if (copyRes?.ok) {
          await telegramAPI("sendMessage", {
            chat_id: userId,
            text: "✅ پیام شما با موفقیت ارسال شد.",
            reply_markup: { keyboard: [[{ text: NEW_LINK_TEXT }]], resize_keyboard: true }
          });
        } else {
          await telegramAPI("sendMessage", { chat_id: userId, text: "❌ خطا در ارسال پیام. لطفاً مجدداً تلاش کنید." });
        }

        await DB.prepare("UPDATE users SET target_user = '', reply_to_user = '', reply_to_msg_id = '' WHERE telegram_id = ?").bind(userId).run();
        return new Response("FWD");
      }

      return new Response("Done");
    }

    const url = new URL(request.url);
    const path = url.pathname.split("/").pop();

    async function hashString(str) {
      const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const securePath = await hashString(BOT_TOKEN);

    if (path === "init") {
      const hookUrl = `${url.origin}/${securePath}`;
      const res = await telegramAPI("setWebhook", { url: hookUrl, drop_pending_updates: true });
      return new Response(JSON.stringify(res));
    }

    if (path === securePath && request.method === "POST") {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update));
      return new Response("OK");
    }

    return new Response("Bot is active");
  }
};
