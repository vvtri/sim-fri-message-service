import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrefixType } from 'common';
import { User } from '../../../auth/entities/user.entity';
import {
  AuthenticateUser,
  CurrentUser,
} from '../../../common/decorators/auth.decorator';
import { PaginationResponse } from '../../../common/decorators/swagger.decorator';
import { ConversationResDto } from '../../dtos/common/res/conversation.res.dto';
import { GetListConversationUserReqDto } from '../../dtos/user/req/conversation.user.req.dto';
import { ConversationUserService } from '../../services/user/conversation.user.service';

@Controller(`${PrefixType.USER}/conversation`)
@AuthenticateUser()
@ApiTags('Conversation User')
export class ConversationUserController {
  constructor(private conversationUserService: ConversationUserService) {}

  @Get()
  @PaginationResponse(ConversationResDto)
  getList(
    @Query() query: GetListConversationUserReqDto,
    @CurrentUser() user: User,
  ) {
    return this.conversationUserService.getList(query, user);
  }

  @Get('by-user/:userId')
  getByUserId(
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: User,
  ) {
    return this.conversationUserService.getByUser(userId, user);
  }

  @Get(':id')
  getDetail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.conversationUserService.getDetail(id, user);
  }
}
