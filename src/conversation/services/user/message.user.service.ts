import { Injectable } from '@nestjs/common';
import { paginate, Pagination } from 'nestjs-typeorm-paginate';
import {
  ConversationMemberRole,
  MessageReadInfoStatus,
  MessageType,
  WS_MESSAGE_EVENT,
} from 'shared';
import { In } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { User } from '../../../auth/entities/user.entity';
import { UserProfileRepository } from '../../../auth/repositories/user-profile.repository';
import { UserRepository } from '../../../auth/repositories/user.repository';
import { genWsConversationRoomName } from '../../../common/utils/socket.util';
import { File } from '../../../file/entities/file.entity';
import { FileRepository } from '../../../file/repositories/file.repository';
import { ChatGateway } from '../../../websocket/gateways/chat.gateway';
import { ConversationResDto } from '../../dtos/common/res/conversation.res.dto';
import { MessageUserInfoResDto } from '../../dtos/common/res/message-user-info.res.dto';
import { MessageResDto } from '../../dtos/common/res/message.res.dto';
import {
  GetListMessageUserReqDto,
  ReactToMessageUserReqDto,
  SendMessageUserReqDto,
} from '../../dtos/user/req/message.user.req.dto';
import { ICreateConversationSocketUserResDto } from '../../dtos/user/res/conversation.socket.user.res.dto';
import { Conversation } from '../../entities/conversation.entity';
import { MessageUserInfo } from '../../entities/message-user-info.entity';
import { Message } from '../../entities/message.entity';
import { ConversationMemberRepository } from '../../repositories/conversation-member.repository';
import { ConversationRepository } from '../../repositories/conversation.repository';
import { MessageUserInfoRepository } from '../../repositories/message-user-info.repository';
import { MessageRepository } from '../../repositories/message.repository';

@Injectable()
export class MessageUserService {
  constructor(
    private chatGateway: ChatGateway,
    private conversationRepo: ConversationRepository,
    private fileRepo: FileRepository,
    private messageRepo: MessageRepository,
    private conversationMemberRepo: ConversationMemberRepository,
    private userProfile: UserProfileRepository,
    private userRepo: UserRepository,
    private messageUserInfoRepo: MessageUserInfoRepository,
  ) {}

  @Transactional()
  async getMessages(dto: GetListMessageUserReqDto, user: User) {
    const { conversationId, limit, page } = dto;

    await this.conversationMemberRepo.findOneByOrThrowNotFoundExc({
      userId: user.id,
      conversationId,
    });

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .orderBy('m.createdAt', 'DESC');

    const { items, meta } = await paginate(qb, { page, limit });

    const messages = await Promise.all(
      items.map(async (item) => {
        const message = await this.messageRepo.findOne({
          where: { id: item.id },
          relations: {
            user: true,
            file: true,
            messageUserInfos: { user: true },
          },
        });

        return MessageResDto.forUser({ data: message });
      }),
    );

    return new Pagination(messages, meta);
  }

  @Transactional()
  async sendMessage(dto: SendMessageUserReqDto, user: User) {
    const { conversationId, fileId, type, content, userIds } = dto;
    let conversation: Conversation;
    let isCreateConversation = false;
    let file: File;

    const userProfile = await this.userProfile.findOne({
      where: { userId: user.id },
      relations: { avatar: true },
    });
    user.userProfile = userProfile;

    if (conversationId) {
      conversation = await this.conversationRepo.findOneOrThrowNotFoundExc({
        where: { id: conversationId, conversationMembers: { userId: user.id } },
      });
    } else {
      const isGroup = userIds.length >= 2;
      const qb = this.conversationRepo
        .createQueryBuilder('c')
        .innerJoin('c.conversationMembers', 'cm')
        .andWhere('cm.userId IN (:...userIds)', { userIds })
        .groupBy('c.id')
        .having('count(*) > 2');

      if (userIds.length > 2) {
        qb.andWhere('c.isGroup = true');
      } else {
        qb.andWhere('c.isGroup = false');
      }

      conversation = await qb.getOne();

      if (!conversation) {
        isCreateConversation = true;

        conversation = await this.createConversation(userIds, user, isGroup);
      }
    }

    conversation.lastActivityTime = new Date();
    await this.conversationRepo.save(conversation);

    if ([MessageType.IMAGE, MessageType.FILE].includes(type)) {
      file = await this.fileRepo.findOneByOrThrowNotFoundExc({
        userId: user.id,
        id: fileId,
      });
    }

    const message = this.messageRepo.create({
      type,
      content,
      file,
      conversationId: conversation.id,
      user,
    });
    await this.messageRepo.save(message);
    message.messageUserInfos = [];

    this.sendSocketMessageSent({
      isCreateConversation,
      conversation,
      message,
      userIds,
      user,
    });

    return MessageResDto.forUser({ data: message });
  }

  @Transactional()
  async readMessage(messageId: number, user: User) {
    let messageUserInfo: MessageUserInfo =
      await this.messageUserInfoRepo.findOne({
        where: { userId: user.id, messageId },
        relations: { user: true },
      });

    if (!messageUserInfo) {
      messageUserInfo = this.messageUserInfoRepo.create({
        user,
        messageId,
      });
    }

    messageUserInfo.status = MessageReadInfoStatus.READ;

    await this.messageUserInfoRepo.save(messageUserInfo);

    this.sendSocketMessageViewed(messageUserInfo);

    return MessageUserInfoResDto.forUser({ data: messageUserInfo });
  }

  @Transactional()
  async reactToMessage(dto: ReactToMessageUserReqDto, user: User) {
    const { messageId, reaction } = dto;

    const messageUserInfo: MessageUserInfo =
      await this.messageUserInfoRepo.findOneOrThrowNotFoundExc({
        where: { userId: user.id, messageId },
        relations: { user: true },
      });

    messageUserInfo.reaction = reaction;
    await this.messageUserInfoRepo.save(messageUserInfo);

    return MessageUserInfoResDto.forUser({ data: messageUserInfo });
  }

  private sendSocketMessageSent({
    conversation,
    isCreateConversation,
    message,
    user,
    userIds,
  }: SendSocketEvent) {
    if (isCreateConversation) {
      const conversationRes = ConversationResDto.forUser({
        data: conversation,
        latestMessage: message,
      });

      const res: ICreateConversationSocketUserResDto = {
        conversation: conversationRes,
        creatorId: user.id,
      };

      this.chatGateway.server
        .to(userIds.map((item) => String(item)))
        .to(String(user.id))
        .emit(WS_MESSAGE_EVENT.CONVERSATION_CREATED, res);
    } else {
      const messageRes = MessageResDto.forUser({ data: message });
      this.chatGateway.server
        .to(genWsConversationRoomName(conversation.id))
        .emit(WS_MESSAGE_EVENT.MESSAGE_SENT, messageRes);
    }
  }

  private async createConversation(
    userIds: number[],
    user: User,
    isGroup: boolean,
  ) {
    const users = await this.userRepo.find({
      where: { id: In(userIds) },
      relations: { userProfile: { avatar: true } },
    });
    const curUserProfile = await this.userProfile.findOneBy({
      userId: user.id,
    });
    const conversationName = `${curUserProfile.name}, ${users
      .map((item) => item.userProfile.name)
      .join(', ')}`;

    const conversation = this.conversationRepo.create({
      isGroup: false,
      name: conversationName,
    });
    await this.conversationRepo.save(conversation);
    const conversationMembers = users.map((item) =>
      this.conversationMemberRepo.create({
        conversation,
        addedId: isGroup ? user.id : undefined,
        user: item,
      }),
    );

    const conversationMemberOwner = this.conversationMemberRepo.create({
      conversation,
      addedId: undefined,
      role: isGroup
        ? ConversationMemberRole.ADMIN
        : ConversationMemberRole.MEMBER,
      user,
    });
    conversationMembers.push(conversationMemberOwner);

    await this.conversationMemberRepo.save(conversationMembers);
    conversation.conversationMembers = conversationMembers;

    return conversation;
  }

  private async sendSocketMessageViewed(messageUserInfo: MessageUserInfo) {
    try {
      const conversation = await this.conversationRepo.findOneBy({
        messages: { id: messageUserInfo.messageId },
      });

      if (conversation) {
        this.chatGateway.server
          .to(genWsConversationRoomName(conversation.id))
          .emit(WS_MESSAGE_EVENT.MESSAGE_VIEWED, messageUserInfo);
      }
    } catch (error) {
      console.log('error', error);
    }
  }
}

interface SendSocketEvent {
  isCreateConversation: boolean;
  conversation: Conversation;
  message: Message;
  userIds: number[];
  user: User;
}