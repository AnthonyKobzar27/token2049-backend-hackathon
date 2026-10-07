

# MessagesClient - messages hits our Twillio endpoint, we forward to agent, agent responds and texts back to message.
class MessagesClient:
    def __init__(self, user: User, agent: Agent):
        self.user = user
        self.agent = agent

    def makeCall(self):
        pass


class User:
    pass

class Agent:
    pass

