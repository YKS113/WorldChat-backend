const User = require("../model/User");
const Room = require("../model/Room");
const Message = require("../model/Message");
const asyncHandler = require("express-async-handler");
const deepl = require('deepl-node');
require('dotenv').config();

const authKey =process.env.DEEPL_KEY;
const translator = new deepl.Translator(authKey);

const getUnreadCount = asyncHandler(async (type, from, to) => {
  const filter = type === "room" ? [to] : [from, to];
  const messageReaders = await Message.find({ sender: { $ne: from } })
    .all("users", filter)
    .select(["readers"])
    .sort({ createdAt: -1 })
    .lean();

  return (
    messageReaders.filter(({ readers }) => readers.indexOf(from) === -1)
      .length || 0
  );
});

const getMessageInfo = asyncHandler(async (type, from, to) => {
  const filter = type === "room" ? [to] : [from, to];
  const message = await Message.findOne()
    .all("users", filter)
    .select(["message", "sender", "updatedAt", "readers"])
    .sort({ createdAt: -1 })
    .lean();

  const unreadCount = await getUnreadCount(type, from, to);

  return {
    latestMessage: message?.message || null,
    latestMessageSender: message?.sender || null,
    latestMessageUpdatedAt: message?.updatedAt || null,
    unreadCount,
  };
});

// READ
const getUserContacts = asyncHandler(async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId)
      return res.status(400).json({ message: "Missing required information." });

    const users = await User.find({ _id: { $ne: userId } })
      .select(["name", "avatarImage", "chatType"])
      .sort({ updatedAt: -1 })
      .lean();

    const rooms = await Room.find()
      .all("users", [userId])
      .select(["name", "users", "avatarImage", "chatType"])
      .sort({ updatedAt: -1 })
      .lean();

    const contacts = users.concat(rooms);
    const contactWithMessages = await Promise.all(
      contacts.map(async (contact) => {
        const { _id, chatType: type } = contact;
        const messageInfo = await getMessageInfo(
          type,
          userId,
          _id.toHexString()
        );

        return {
          ...contact,
          ...messageInfo,
        };
      })
    );

    return res.status(200).json({ data: contactWithMessages });
  } catch (err) {
    return res.status(404).json({ message: err.message });
  }
});

const getUserMessages = asyncHandler(async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, chatId } = req.query;

    if (!userId || !type || !chatId) {
      return res.status(400).json({ message: "Missing required information." });
    }

    const filter = type === "room" ? [chatId] : [userId, chatId];
    const messages = await Message.find()
      .all("users", filter)
      .sort({ createdAt: 1 })
      .lean();

    const messagesWithAvatar = await Promise.all(
      messages.map(async (msg) => {
        const senderId = msg.sender;
        const user = await User.findById(senderId).lean();
        return {
          ...msg,
          avatarImage: user.avatarImage,
        };
      })
    );

    return res.status(200).json({ data: messagesWithAvatar });
  } catch (err) {
    return res.status(404).json({ message: err.message });
  }
});

// CREATE
const postUserMessage = asyncHandler(async (req, res) => {
  try {
    const { userId } = req.params;
    const { chatId } = req.query;
    let  { message,targetlang } = req.body;

    if (!userId || !chatId || !message) {
      return res.status(400).json({ message: "Missing required information." });
    }

    //--------------------------Translation------------------------------
    const result = await translator.translateText(message, null, targetlang);
    // console.log(result.text);
    message = result.text;
    
    //----------------------------------------------------------------

    const newMessage = await Message.create({
      message,
      users: [userId, chatId],
      sender: userId,
      readers: [],
    });

    return res.status(200).json({ data: newMessage });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

const postRoom = asyncHandler(async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { name, users, avatarImage } = req.body;

    if (!userId || !name || !users || !avatarImage) {
      return res.status(400).json({ message: "Missing required information." });
    }

    const data = await Room.create({
      name,
      users: [...users, userId],
      avatarImage,
      chatType: "room",
    });

    return res.json({ data, messages: "Successfully created a room." });
  } catch (err) {
    return res.status(500).json({ message: e.message });
  }
});

// UPDATE
const updateMessageReadStatus = asyncHandler(async (req, res) => {
  try {
    // chatId message has been read by userId
    const { userId } = req.params;
    const { type, chatId } = req.query;

    if (!userId || !type || !chatId) {
      return res.status(400).json({ message: "Missing required information." });
    }

    const filter = type === "room" ? [chatId] : [userId, chatId];

    // Remove all messages in chat where the sender is not you
    const messages = await Message.find({ sender: { $ne: userId } })
      .all("users", filter)
      .sort({ createdAt: 1 });

    // Get the corresponding values ​​​​of message and reader
    const messageReaderMap = messages.reduce((prev, curr) => {
      return { ...prev, [curr._id.toHexString()]: curr.readers };
    }, {});

    // Check if userId already exists in readers -> If it does not exist, add it
    Object.entries(messageReaderMap).forEach(([key, value]) => {
      const userHasRead = value.indexOf(userId) > -1;
      if (!userHasRead) messageReaderMap[key].push(userId); //push if you haven't read yet
    });

    // Update read
    await Promise.all(
      Object.keys(messageReaderMap).map(async (msgId) => {
        return await Message.findByIdAndUpdate(
          { _id: msgId },
          { readers: messageReaderMap[msgId] },
          { new: true }
        ).lean();
      })
    );

    return res
      .status(200)
      .json({ data: null, message: "Successfully updated." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = {
  getUserContacts,
  getUserMessages,
  postUserMessage,
  postRoom,
  updateMessageReadStatus,
};
